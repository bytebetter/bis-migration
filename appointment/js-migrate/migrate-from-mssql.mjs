import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import pg from "pg";
import {
  MSSQL_APPOINTMENT_DETAIL_BY_IDS_SELECT,
  MSSQL_APPOINTMENT_ID_SELECT,
  MSSQL_APPOINTMENT_SCHEDULE_DATETIME_FILTER,
  MSSQL_APPOINTMENT_SELECT,
  createMssqlAppointmentSelectBundle,
} from "./mssqlAppointmentSelect.mjs";
import {
  bindCreatedDateOrNumericKeyset,
  advanceCreatedDateKeysetFromProbe,
} from "../../shared/js-migrate/createdDateKeysetFetch.mjs";
import {
  initCreatedDateKeysetState,
  setupCreatedDateMigrationSort,
} from "../../shared/js-migrate/setupCreatedDateMigrationSort.mjs";
import { ensureAppointmentStagingDdl } from "./appointmentPgDdl.mjs";
import {
  buildFieldIssueLogPayload,
  createFieldIssueAccumulator,
  mergeFieldIssueChunk,
  writeFieldIssueLogFile,
} from "../../shared/js-migrate/fieldIssueLog.mjs";
import {
  resetAppointmentIdSequenceIfEmpty,
  runAppointmentChunkPostLoad,
  syncAppointmentIdSequence,
} from "./appointmentMapping.mjs";
import {
  createUiState,
  endProgress,
  formatSec,
  markProgressInline,
  renderProgress,
  writeOutLine,
} from "../../shared/js-migrate/progressUi.mjs";
import { readNumericSourceKeyBounds } from "../../shared/js-migrate/migrateCliArgs.mjs";
import {
  logByIdMigrationRun,
  plannedProgressForSourceIds,
} from "../../shared/js-migrate/sourceIdsSupport.mjs";
import { mergeMigrationWithCli } from "../../shared/js-migrate/mergeMigrationConfig.mjs";
import {
  applySourceIndexToMigrateJob,
  buildIndexCheckpointSuffix,
  narrowPlannedRowsForIndex,
  resolvePageSize,
  plannedRowsForPageSize,
  trimRowsToMigrateCap,
  capAdvanceToMigratePlan,
  shouldStopMigratePagination,
} from "../../shared/js-migrate/sourceIndexRange.mjs";
import { prepareMigrateRowPlan } from "../../shared/js-migrate/sourceCountSnapshot.mjs";
import { fetchMssqlRowsByIds } from "../../shared/js-migrate/fetchMssqlByIds.mjs";
import {
  batchIds,
  resolveMigrationSourceIds,
} from "../../shared/js-migrate/repairFromLog.mjs";
import { REPAIR_SPEC_APPOINTMENT } from "../../shared/js-migrate/migrateTableSpecs.mjs";
import {
  finalizeRepairFromLog,
  noteRepairBatchNotFoundInSource,
} from "../../shared/js-migrate/repairSummary.mjs";
import {
  appointmentScheduleNumericRangePredicate,
  bindAppointmentMssqlCommon,
} from "../../shared/js-migrate/migrateMssqlBindings.mjs";
import {
  optionalDetailRowCount,
  resolveKeysetAdvance,
} from "../../shared/js-migrate/twoStepKeyset.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = "appointment";
/** fallback keyset เดิม (expression-based) ใช้เมื่อเปิดโหมด compatibility */
const MSSQL_SCHEDULE_ID_NUMERIC_EXPR =
  "TRY_CONVERT(BIGINT, NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(50), [Schedule_ID]))), ''))";
const MSSQL_SCHEDULE_ID_NATIVE_EXPR = "[Schedule_ID]";

const APPOINTMENT_COLUMNS = [
  "schedule_datetime",
  "schedule_number",
  "prefix",
  "name",
  "surname",
  "patient_type",
  "pid",
  "age",
  "receive_date",
  "login_name",
  "memo_detail",
  "fail",
  "telephone",
  "inventional",
  "modified_date",
  "modified_user",
  "biopsy_proc",
  "referring_md",
  "biopsy_comment",
  "biopsy_radiologist",
  "schedule_id",
  "mobile",
  "location_id",
  "is_online",
  "have_doc",
  "have_cd",
  "right_id",
];

function getConfigPath() {
  const idx = process.argv.indexOf("--config");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return "../../migration.config.local.json";
}

function getProfileName() {
  const idx = process.argv.indexOf("--profile");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env.MIGRATION_PROFILE || null;
}

function nowStamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function parseMssqlUrl(rawUrl) {
  const normalized = rawUrl.replace(/^microsoftsqlserver:\/\//i, "mssql://");
  const u = new URL(normalized);
  return {
    server: u.hostname,
    port: u.port ? Number(u.port) : 1433,
    database: u.pathname.replace(/^\/+/, ""),
    user: decodeURIComponent(u.username || ""),
    password: decodeURIComponent(u.password || ""),
    options: {
      encrypt: true,
      trustServerCertificate: true,
    },
    pool: { max: 5, min: 0 },
  };
}

function tediousOptionsFromSource(sourceConfig = {}) {
  return {
    encrypt: sourceConfig.encrypt !== false,
    trustServerCertificate: sourceConfig.trustServerCertificate !== false,
    requestTimeout:
      sourceConfig.requestTimeout == null
        ? 0
        : Number(sourceConfig.requestTimeout),
    connectTimeout:
      sourceConfig.connectTimeout == null
        ? 60000
        : Number(sourceConfig.connectTimeout),
    cancelTimeout:
      sourceConfig.cancelTimeout == null
        ? 0
        : Number(sourceConfig.cancelTimeout),
  };
}

function buildMssqlConfig(sourceConfig = {}) {
  const timeouts = tediousOptionsFromSource(sourceConfig);
  if (sourceConfig.mssqlUrl) {
    const base = parseMssqlUrl(sourceConfig.mssqlUrl);
    return {
      ...base,
      options: {
        ...base.options,
        ...timeouts,
      },
    };
  }
  return {
    server: sourceConfig.server,
    port: Number(sourceConfig.port ?? 1433),
    database: sourceConfig.database,
    user: sourceConfig.user,
    password: sourceConfig.password,
    options: timeouts,
    pool: { max: 5, min: 0 },
  };
}

function resolveRuntimeConfig(rawConfig, fallbackProfile) {
  if (!rawConfig?.profiles) return rawConfig;

  const selectedProfile =
    getProfileName() ?? rawConfig.defaultProfile ?? fallbackProfile;
  let profileConfig = rawConfig.profiles[selectedProfile];
  if (profileConfig === undefined) {
    if (selectedProfile === "appointment") {
      console.error(
        ">>> คำเตือน: ไม่พบ profiles.appointment ใน config — ใช้ shared อย่างเดียว (แนะนำคัดลอก profile appointment จาก migration.config.example.json ไปใส่ migration.config.local.json)",
      );
      profileConfig = {};
    } else {
      throw new Error(
        `Profile '${selectedProfile}' not found in config.profiles — ตรวจสอบ --profile, defaultProfile, หรือเพิ่ม key ใน migration.config.local.json ให้ตรง (ดูตัวอย่างที่ migration.config.example.json)`,
      );
    }
  }

  const shared = rawConfig.shared ?? {};
  return {
    ...shared,
    ...profileConfig,
    source: { ...(shared.source ?? {}), ...(profileConfig.source ?? {}) },
    target: { ...(shared.target ?? {}), ...(profileConfig.target ?? {}) },
    migration: {
      ...(shared.migration ?? {}),
      ...(profileConfig.migration ?? {}),
    },
    __profileName: selectedProfile,
  };
}

function assertMssqlSourceReady(source) {
  if (!source || source.mssqlUrl) return;
  const pw = source.password;
  if (
    pw == null ||
    String(pw).trim() === "" ||
    String(pw) === "YOUR_MSSQL_PASSWORD"
  ) {
    throw new Error(
      "MSSQL: กำหนด source.password ใน migration.config.local.json ให้เป็นรหัสจริง",
    );
  }
}

function toStr(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d} 00:00:00.000`;
  }
  return String(v);
}

function rowToStagingArrays(row, rowIdx, arrays, cols) {
  const g = (k) => {
    const v = row[k] ?? row[k.toLowerCase()] ?? row[k.toUpperCase()];
    return v === undefined || v === null ? null : toStr(v);
  };
  for (let c = 0; c < cols.length; c++) arrays[c][rowIdx] = g(cols[c]);
}

function readJsonIfExists(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) return fallbackValue;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function bracketIdent(value) {
  return `[${String(value).replaceAll("]", "]]")}]`;
}

function getScheduleIdForLog(row) {
  if (!row) return "";
  const v = row.schedule_id ?? row.SCHEDULE_ID ?? row.Schedule_ID;
  if (v == null) return "";
  return String(v)
    .replace(/^\uFEFF/, "")
    .trim();
}

function shouldKeepChunkDetail({
  status,
  chunkIndex,
  chunkLogMode,
  chunkSampleEvery,
}) {
  if (chunkLogMode === "none") return status === "failed";
  if (chunkLogMode === "full") return true;
  if (status === "failed") return true;
  return chunkIndex === 1 || chunkIndex % chunkSampleEvery === 0;
}

function toBigIntish(v) {
  if (v == null) return -1n;
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && v.trim() !== "" && /^-?\d+$/.test(v.trim())) {
    return BigInt(v.trim());
  }
  return BigInt(String(v));
}

function bigIntToJsKeysetValue(b) {
  if (b >= -9007199254740991n && b <= 9007199254740991n) return Number(b);
  return b.toString();
}

function keysetIdForCheckpoint(v) {
  if (v == null) return null;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" && Number.isFinite(v)) return String(Math.trunc(v));
  return v;
}

const SCHED_RANGE_COMPAT = appointmentScheduleNumericRangePredicate(
  MSSQL_SCHEDULE_ID_NUMERIC_EXPR,
);
/** keyset เดิม (compat) WHERE … numeric expr */
function buildMssqlAppointmentKeysetSelect() {
  const marker = "FROM {{sourceObject}}";
  const s = MSSQL_APPOINTMENT_SELECT;
  const idx = s.indexOf(marker);
  if (idx < 0) {
    throw new Error("MSSQL_APPOINTMENT_SELECT: missing FROM {{sourceObject}}");
  }
  const head = s.slice(0, idx).trimEnd();
  const headWithTop = head.replace(/^SELECT\s*/i, "SELECT TOP (@page) ");
  return `${headWithTop},
  ${MSSQL_SCHEDULE_ID_NUMERIC_EXPR} AS __mssql_schedule_id
FROM {{sourceObject}}
WHERE ${MSSQL_SCHEDULE_ID_NUMERIC_EXPR} > @afterScheduleId
 AND (${SCHED_RANGE_COMPAT})
ORDER BY ${MSSQL_SCHEDULE_ID_NUMERIC_EXPR} ASC, [Schedule_ID] ASC;`;
}

const SCHED_RANGE_NATIVE = appointmentScheduleNumericRangePredicate(
  "CAST([Schedule_ID] AS BIGINT)",
);
function buildMssqlAppointmentNativeKeysetSelect() {
  const marker = "FROM {{sourceObject}}";
  const s = MSSQL_APPOINTMENT_SELECT;
  const idx = s.indexOf(marker);
  if (idx < 0) {
    throw new Error("MSSQL_APPOINTMENT_SELECT: missing FROM {{sourceObject}}");
  }
  const head = s.slice(0, idx).trimEnd();
  const headWithTop = head.replace(/^SELECT\s*/i, "SELECT TOP (@page) ");
  return `${headWithTop}
FROM {{sourceObject}}
WHERE ${MSSQL_SCHEDULE_ID_NATIVE_EXPR} > @afterScheduleId
 AND (${SCHED_RANGE_NATIVE})
ORDER BY ${MSSQL_SCHEDULE_ID_NATIVE_EXPR} ASC;`;
}

/**
 * รันหนึ่งรอบเต็ม: OFFSET pagination, checkpoint, chunk log — เทียบ `examination` runTableJob
 */
async function runAppointmentTableJob({
  mssqlPool,
  pgClient,
  migrationConfig = {},
  source,
}) {
  const key = KEY;
  const batchSize = Math.max(
    50,
    Math.min(5000, Number(migrationConfig.batchSize ?? 2000)),
  );
  const checkpointEnabled = migrationConfig.enableCheckpoint !== false;
  const checkpointDir = path.resolve(
    __dirname,
    migrationConfig.checkpointDir ?? "./checkpoints",
  );
  fs.mkdirSync(checkpointDir, { recursive: true });
  const kb = readNumericSourceKeyBounds(migrationConfig);
  const indexCkSuffix = buildIndexCheckpointSuffix(migrationConfig);
  const rowModeSlug =
    migrationConfig.migrateRowMode === "insert-only" ? "ins" : "ovr";
  let checkpointBasename = key;
  if (indexCkSuffix) {
    checkpointBasename = `${key}${indexCkSuffix}`;
  } else if (
    kb.min != null ||
    kb.max != null ||
    migrationConfig.migrateRowMode === "insert-only"
  ) {
    const ckParts = [rowModeSlug];
    if (kb.min != null) ckParts.push(`from${kb.min}`);
    if (kb.max != null) ckParts.push(`to${kb.max}`);
    checkpointBasename = `${key}-${ckParts.join("-")}`;
  }
  const checkpointPath = path.join(checkpointDir, `${checkpointBasename}.json`);
  const checkpoint = readJsonIfExists(checkpointPath, {
    key,
    offset: 0,
    mssqlKeysetAfter: null,
    completed: false,
    updatedAt: null,
  });
  let offset = Number(
    migrationConfig.startOffset ?? (checkpointEnabled ? checkpoint.offset : 0),
  );
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  const sourceSchema = source?.schema ?? "dbo";
  const sourceTable = source?.table ?? "schedule";
  const sourceObject = `${bracketIdent(sourceSchema)}.${bracketIdent(sourceTable)}`;
  const sourceObjectNoLock = `${sourceObject} WITH (NOLOCK)`;
  const appointmentSortBundle = await setupCreatedDateMigrationSort(mssqlPool, {
    migrationConfig,
    sourceSchema,
    sourceTable,
    tableLabel: key,
    createSelectBundle: createMssqlAppointmentSelectBundle,
  });
  const useMssqlKeysetBase =
    migrationConfig.useMssqlKeyset === undefined ||
    migrationConfig.useMssqlKeyset === true;
  let useMssqlKeyset = useMssqlKeysetBase;
  if (useMssqlKeyset && offset > 0 && checkpoint.mssqlKeysetAfter == null) {
    useMssqlKeyset = false;
    console.error(
      `>>> [${key}] resume: ใช้ OFFSET (checkpoint เก่า) — ลบ checkpoint แล้วรันใหม่จะกลับไป keyset`,
    );
  }
  const idx = applySourceIndexToMigrateJob({
    key,
    migrationConfig,
    checkpointEnabled,
    offset,
    useMssqlKeyset,
  });
  offset = idx.offset;
  useMssqlKeyset = idx.useMssqlKeyset;
  const mssqlKeysetMode = String(
    migrationConfig.mssqlKeysetMode ?? "native",
  ).toLowerCase();
  const useTwoStepFetch =
    migrationConfig.mssqlTwoStepFetch === undefined ||
    migrationConfig.mssqlTwoStepFetch === true;
  const useNativeKeyset = mssqlKeysetMode !== "compat";
  const useCreatedDateKeyset =
    appointmentSortBundle?.createdDateColumn != null && useMssqlKeyset;
  const scheduleIdOrderExpr = appointmentSortBundle?.createdDateColumn
    ? appointmentSortBundle.orderBy
    : useNativeKeyset
      ? `${MSSQL_SCHEDULE_ID_NATIVE_EXPR} ASC`
      : `${MSSQL_SCHEDULE_ID_NUMERIC_EXPR} ASC, [Schedule_ID] ASC`;

  const dtFilterOneLine = MSSQL_APPOINTMENT_SCHEDULE_DATETIME_FILTER.replace(
    /\s+/g,
    " ",
  ).trim();
  const offsetSelectTpl = MSSQL_APPOINTMENT_SELECT.replace(
    "WHERE {{appointmentScheduleDatetimeFilter}}",
    `WHERE (${dtFilterOneLine}) AND (${SCHED_RANGE_COMPAT})`,
  );
  const idProbeSql = (() => {
    if (appointmentSortBundle?.createdDateColumn) {
      return `
SELECT TOP (@page)
  CAST([Schedule_ID] AS BIGINT) AS schedule_id,
  ${appointmentSortBundle.sortKeyExpr} AS __mssql_sort_key
FROM {{sourceObject}}
WHERE ${appointmentSortBundle.sortKeyExpr} > @afterSortKey
  AND (${SCHED_RANGE_NATIVE})
ORDER BY ${appointmentSortBundle.orderBy}`.trim();
    }
    return MSSQL_APPOINTMENT_ID_SELECT.replace(
      "[Schedule_ID] > @afterScheduleId",
      `[Schedule_ID] > @afterScheduleId AND (${SCHED_RANGE_NATIVE})`,
    );
  })().replaceAll("{{sourceObject}}", sourceObjectNoLock);

  const detailOrderBy =
    appointmentSortBundle?.orderBy ?? "[Schedule_ID] ASC";
  const detailSqlTemplate = MSSQL_APPOINTMENT_DETAIL_BY_IDS_SELECT.replace(
    "ORDER BY [Schedule_ID] ASC",
    `ORDER BY ${detailOrderBy}`,
  ).replaceAll("{{sourceObject}}", sourceObjectNoLock);
  const selectSql = (
    useMssqlKeyset
      ? useNativeKeyset
        ? buildMssqlAppointmentNativeKeysetSelect()
        : buildMssqlAppointmentKeysetSelect()
      : offsetSelectTpl
  )
    .replaceAll("{{sourceObject}}", sourceObjectNoLock)
    .replaceAll("{{orderBy}}", scheduleIdOrderExpr);

  let mssqlKeysetAfter = checkpoint.mssqlKeysetAfter;
  if (useCreatedDateKeyset) {
    const keysetState = initCreatedDateKeysetState(
      checkpoint,
      checkpointEnabled,
      appointmentSortBundle,
      { legacyNumericDefault: -1 },
    );
    if (keysetState.sortKeyVersionUpgraded) offset = 0;
    mssqlKeysetAfter = keysetState.mssqlKeysetAfter ?? "";
  } else if (useMssqlKeyset && mssqlKeysetAfter == null) {
    mssqlKeysetAfter = -1;
  } else if (!useMssqlKeyset) {
    mssqlKeysetAfter = null;
  }
  if (useMssqlKeyset && !useCreatedDateKeyset && kb.min != null) {
    const floorExclusive = kb.min - 1n;
    const curBi = toBigIntish(mssqlKeysetAfter);
    if (curBi < floorExclusive) {
      console.error(
        `>>> [${key}] ปรับ keyset ให้ครอบ sourceKeyNumericMin (${kb.min}): after ${JSON.stringify(mssqlKeysetAfter)} → ${floorExclusive.toString()} (exclusive)`,
      );
      mssqlKeysetAfter = bigIntToJsKeysetValue(floorExclusive);
    }
  }

  if (migrationConfig.migrateRowMode === "insert-only") {
    console.error(
      `>>> [${key}] migrateRowMode=insert-only (เพิ่มแถวใหม่ — ข้ามอัปเดตแถวจริงเดิม; แถว placeholder ไม่ทราบชื่อจาก examination ยังคงไว้และ INSERT จาก MSSQL ได้)`,
    );
  } else if (kb.min != null || kb.max != null) {
    console.error(
      `>>> [${key}] source key numeric range: min=${kb.min ?? "unset"} max=${kb.max ?? "unset"}`,
    );
  }

  const chunkLogMode = String(
    migrationConfig.chunkLogMode ?? "full",
  ).toLowerCase();
  const chunkSampleEvery = Math.max(
    1,
    Number(migrationConfig.chunkSampleEvery ?? 50),
  );
  const sourceLimitRaw = migrationConfig.sourceLimit;
  const sourceLimit =
    sourceLimitRaw == null ? null : Math.max(1, Number(sourceLimitRaw));
  const progressEnabled = migrationConfig.progressUi !== false;
  const singleLineUi = migrationConfig.singleLineUi !== false;
  const progressStartedAt = Date.now();
  let sourceRowCountTotal = sourceLimit;
  if (sourceRowCountTotal == null && progressEnabled) {
    try {
      const countReq = mssqlPool.request();
      bindAppointmentMssqlCommon(countReq, migrationConfig, sql);
      const countSql = `SELECT COUNT_BIG(1) AS total FROM ${sourceObjectNoLock} WHERE (${SCHED_RANGE_NATIVE});`;
      const countRes = await countReq.query(countSql);
      sourceRowCountTotal = Number(countRes.recordset?.[0]?.total ?? 0);
    } catch {
      sourceRowCountTotal = null;
    }
  }
  const plannedRows = prepareMigrateRowPlan({
        migrationConfig: migrationConfig,
        sourceRowCountTotal,
        offset,
        indexLimited: idx.indexLimited,
        sourceIndexFrom: idx.sourceIndexFrom,
        sourceIndexTo: idx.sourceIndexTo,
      });
  let progressTotal = plannedRows ?? null;
  let plannedChunks =
    plannedRows != null && plannedRows > 0
      ? Math.ceil(plannedRows / batchSize)
      : null;
  const probeTiming = migrationConfig.probeTiming === true;
  const debugLogs = migrationConfig.debugLogs === true || probeTiming;
  const uiState = createUiState();
  if (sourceLimit != null) {
    console.error(
      `>>> [${key}] TEMP sourceLimit enabled: ${sourceLimit} records`,
    );
  }
  if (plannedChunks != null) {
    console.error(
      `>>> [${key}] plan: ${plannedRows} rows, ~${plannedChunks} chunks`,
    );
  }
  if (probeTiming) {
    console.error(
      `>>> [${key}] probeTiming enabled (MSSQL query latency logs)`,
    );
  }

  console.error(
    `>>> [${key}] start offset: ${offset}${useMssqlKeyset ? ` (MSSQL keyset:${useNativeKeyset ? "native" : "compat"} ตาม [Schedule_ID], twoStep=${useTwoStepFetch})` : " (MSSQL OFFSET ตาม [Schedule_ID] order)"}`,
  );
  await ensureAppointmentStagingDdl(pgClient);
  await resetAppointmentIdSequenceIfEmpty(pgClient);
  await pgClient.query(`
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'appointment'
      AND column_name = 'old_db_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_appointment_old_db_id
      ON public.appointment (old_db_id);
  END IF;
END $$;
  `);

  let total = 0;
  const failedScheduleIdSet = new Set();
  const fieldIssueAcc = createFieldIssueAccumulator("schedule_id");
  const fieldIssueLogPath = path.join(
    path.resolve(__dirname, "logs"),
    `migration-field-issues-appointment-${nowStamp()}.json`,
  );
  const chunkResults = [];
  let chunkIndex = 0;
  let successChunkCount = 0;
  let failedChunkCount = 0;

  const logsDir = path.resolve(__dirname, "logs");
  const repairSourceIds = resolveMigrationSourceIds(
    migrationConfig,
    logsDir,
    REPAIR_SPEC_APPOINTMENT,
  );
  const repairBatches =
    repairSourceIds != null ? [...batchIds(repairSourceIds, batchSize)] : null;
  let repairBatchIndex = 0;
  const repairNotFoundInSource = repairSourceIds != null ? new Set() : null;
  if (repairSourceIds != null && repairSourceIds.length === 0) {
    console.error(`>>> [${key}] repair-from-log: ไม่มี id ให้ migrate`);
    return {
      key,
      totalRowsRead: 0,
      fieldIssueLogPath: null,
      checkpointPath: null,
      chunkCount: 0,
      successChunkCount: 0,
      failedChunkCount: 0,
      chunkLogMode,
      chunkSampleEvery,
      chunkResults: [],
    };
  }
  if (repairSourceIds != null) {
    const idPlan = plannedProgressForSourceIds(repairSourceIds, batchSize);
    if (idPlan) {
      plannedRows = idPlan.plannedRows;
      plannedChunks = idPlan.plannedChunks;
      progressTotal = idPlan.plannedRows;
    }
    logByIdMigrationRun(
      key,
      repairSourceIds.length,
      "schedule_id",
      migrationConfig,
    );
  }

  while (true) {
    const pageSize = resolvePageSize({
      batchSize,
      total,
      sourceLimit,
      plannedRows: plannedRowsForPageSize(plannedRows, migrationConfig, idx.indexLimited),
    });
    if (pageSize <= 0) break;
    const nextChunkIndex = chunkIndex + 1;
    if (debugLogs && !singleLineUi) {
      writeOutLine(
        `>>> [${key}] fetch chunk ${nextChunkIndex}: offset=${offset} pageSize=${pageSize}`,
        uiState,
      );
    }

    let fetchElapsedMs = 0;
    let rows = [];
    /** โหมด two-step: จำนวนแถวตามลำดับ keyset (TOP @page) — ไม่ใช่แถวจาก detail ที่อาจพองจาก Schedule_ID ซ้ำ */
    let twoStepKeysetAdvance = null;
    let twoStepFirstScheduleIdNum = null;
    let twoStepLastScheduleIdNum = null;

    if (repairBatches) {
      if (repairBatchIndex >= repairBatches.length) break;
      const idBatch = repairBatches[repairBatchIndex++];
      const fetchStartedAt = Date.now();
      rows = await fetchMssqlRowsByIds(mssqlPool, sql, {
        ids: idBatch,
        detailSqlTemplate,
      });
      fetchElapsedMs = Date.now() - fetchStartedAt;
      if (repairNotFoundInSource) {
        noteRepairBatchNotFoundInSource(
          repairNotFoundInSource,
          idBatch,
          rows,
          (r) => getScheduleIdForLog(r),
        );
      }
      if (rows.length > 0) {
        twoStepFirstScheduleIdNum = Number.parseInt(idBatch[0], 10);
        twoStepLastScheduleIdNum = Number.parseInt(
          idBatch[idBatch.length - 1],
          10,
        );
        twoStepKeysetAdvance = idBatch.length;
      }
      if (rows.length === 0) continue;
    } else if (useMssqlKeyset && useNativeKeyset && useTwoStepFetch) {
      const probeStartedAt = Date.now();
      const probeReq = mssqlPool.request();
      bindAppointmentMssqlCommon(probeReq, migrationConfig, sql);
      bindCreatedDateOrNumericKeyset(
        probeReq,
        sql,
        useCreatedDateKeyset ? appointmentSortBundle : null,
        {
          mssqlKeysetAfter: String(mssqlKeysetAfter ?? ""),
          numericAfter: toBigIntish(mssqlKeysetAfter),
          numericParam: "afterScheduleId",
        },
      );
      const idRes = await probeReq
        .input("page", sql.Int, pageSize)
        .query(idProbeSql);
      const probeMs = Date.now() - probeStartedAt;
      const idRows = idRes.recordset || [];
      if (useCreatedDateKeyset && idRows.length > 0) {
        mssqlKeysetAfter = advanceCreatedDateKeysetFromProbe(
          idRows,
          appointmentSortBundle,
          {
            mssqlKeysetAfter: String(mssqlKeysetAfter ?? ""),
            numericAfter: toBigIntish(mssqlKeysetAfter),
          },
        ).mssqlKeysetAfter;
      }
      const ids = idRows
        .map((x) => Number.parseInt(x?.schedule_id ?? "", 10))
        .filter((v) => Number.isFinite(v));
      twoStepKeysetAdvance = ids.length;
      if (ids.length > 0) {
        twoStepFirstScheduleIdNum = ids[0];
        twoStepLastScheduleIdNum = ids[ids.length - 1];
      }
      if (ids.length === 0) {
        rows = [];
        fetchElapsedMs = probeMs;
      } else {
        const detailStartedAt = Date.now();
        rows = await fetchMssqlRowsByIds(mssqlPool, sql, {
          ids,
          detailSqlTemplate,
        });
        fetchElapsedMs = probeMs + (Date.now() - detailStartedAt);
      }
    } else {
      const fetchStartedAt = Date.now();
      const rq = mssqlPool.request();
      bindAppointmentMssqlCommon(rq, migrationConfig, sql);
      const r = useMssqlKeyset
        ? await rq
            .input("afterScheduleId", sql.BigInt, toBigIntish(mssqlKeysetAfter))
            .input("page", sql.Int, pageSize)
            .query(selectSql)
        : await rq
            .input("offset", sql.Int, offset)
            .input("page", sql.Int, pageSize)
            .query(selectSql);
      fetchElapsedMs = Date.now() - fetchStartedAt;
      rows = r.recordset || [];
    }
    if (debugLogs && !singleLineUi) {
      writeOutLine(
        `>>> [${key}] fetched rows: ${rows.length} (chunk ${nextChunkIndex}, mssql_query_ms=${fetchElapsedMs})`,
        uiState,
      );
    }
    rows = trimRowsToMigrateCap(rows, total, plannedRows, migrationConfig, idx.indexLimited);
    if (rows.length === 0) {
      break;
    }

    const n = rows.length;
    let advance = resolveKeysetAdvance(twoStepKeysetAdvance, n);
    advance = capAdvanceToMigratePlan(
      advance,
      total,
      plannedRows,
      migrationConfig,
      idx.indexLimited,
    );
    if (advance <= 0) break;
    chunkIndex += 1;
    const chunkStartedAt = Date.now();
    const sourceOffsetStart = offset;
    const sourceOffsetEnd = offset + advance - 1;
    const firstScheduleId =
      twoStepFirstScheduleIdNum != null
        ? String(twoStepFirstScheduleIdNum)
        : getScheduleIdForLog(rows[0]);
    const lastScheduleId =
      twoStepLastScheduleIdNum != null
        ? String(twoStepLastScheduleIdNum)
        : getScheduleIdForLog(rows[n - 1]);
    const arrays = APPOINTMENT_COLUMNS.map(() => new Array(n));
    for (let i = 0; i < n; i++) {
      rowToStagingArrays(rows[i], i, arrays, APPOINTMENT_COLUMNS);
    }

    let step = "begin chunk transaction";
    let lastChunkProcessMs = 0;
    let postLoadMs = 0;
    try {
      await pgClient.query("BEGIN");
      step = "truncate staging";
      await pgClient.query("TRUNCATE TABLE migrate_stg.appointment_mssql;");
      step = "insert staging";
      const unnestArgs = arrays
        .map((_, idx) => `$${idx + 1}::text[]`)
        .join(", ");
      await pgClient.query(
        `INSERT INTO migrate_stg.appointment_mssql (${APPOINTMENT_COLUMNS.join(", ")}) SELECT * FROM unnest(${unnestArgs});`,
        arrays,
      );
      step = "run appointment post-load (map -> public.appointment)";
      const postLoadStartedAt = Date.now();
      const postLoadResult = await runAppointmentChunkPostLoad(pgClient, rows, {
        migrationKey: key,
        chunkIndex,
        migrateRowMode: migrationConfig.migrateRowMode ?? "overwrite",
      });
      mergeFieldIssueChunk(fieldIssueAcc, postLoadResult);
      for (const sid of postLoadResult?.failedScheduleIds ?? [])
        failedScheduleIdSet.add(sid);
      postLoadMs = Date.now() - postLoadStartedAt;
      await pgClient.query("COMMIT");
      lastChunkProcessMs = Date.now() - chunkStartedAt;
      successChunkCount += 1;
      const chunkResult = {
        chunkIndex,
        status: "success",
        sourceOffsetStart,
        sourceOffsetEnd,
        rowCount: advance,
        ...optionalDetailRowCount(advance, n),
        firstScheduleId,
        lastScheduleId,
        mssqlFetchMs: fetchElapsedMs,
        chunkTotalMs: lastChunkProcessMs,
      };
      if (
        shouldKeepChunkDetail({
          status: "success",
          chunkIndex,
          chunkLogMode,
          chunkSampleEvery,
        })
      ) {
        chunkResults.push(chunkResult);
      }
    } catch (err) {
      await pgClient.query("ROLLBACK");
      failedChunkCount += 1;
      const chunkTotalMs = Date.now() - chunkStartedAt;
      writeOutLine(
        `>>> [${key}] chunk ${chunkIndex} failed after ${chunkTotalMs}ms (mssql_fetch ${fetchElapsedMs}ms) at step: ${step}`,
        uiState,
      );
      chunkResults.push({
        chunkIndex,
        status: "failed",
        sourceOffsetStart,
        sourceOffsetEnd,
        rowCount: advance,
        ...optionalDetailRowCount(advance, n),
        firstScheduleId,
        lastScheduleId,
        mssqlFetchMs: fetchElapsedMs,
        chunkTotalMs,
        failedAtStep: step,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(
        `[${key}] failed chunk ${chunkIndex} (offset ${sourceOffsetStart}-${sourceOffsetEnd}, schedule_id ${firstScheduleId}..${lastScheduleId}) at step '${step}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    total += advance;
    if (!repairBatches) {
      offset += advance;
      if (useMssqlKeyset) {
        if (twoStepLastScheduleIdNum != null) {
          mssqlKeysetAfter = twoStepLastScheduleIdNum;
        } else if (useNativeKeyset) {
          mssqlKeysetAfter = rows[n - 1].schedule_id;
        } else {
          mssqlKeysetAfter = rows[n - 1].__mssql_schedule_id;
        }
      }
    }
    if (progressEnabled && !singleLineUi) {
      writeOutLine(
        `... [${key}] chunk ${chunkIndex} ใช้เวลา ${formatSec(lastChunkProcessMs)} (fetch ${formatSec(fetchElapsedMs)}, post ${formatSec(postLoadMs)})`,
        uiState,
      );
    }
    if (debugLogs && !singleLineUi) {
      writeOutLine(
        `>>> [${key}] chunk ${chunkIndex}/${plannedChunks ?? "?"} done ${formatSec(
          Date.now() - chunkStartedAt,
        )} (fetch ${formatSec(fetchElapsedMs)}, post ${formatSec(postLoadMs)}) detailRows ${n}${n !== advance ? ` keysetAdvance ${advance}` : ""}, total ${total}/${plannedRows ?? "?"}`,
        uiState,
      );
    }
    if (checkpointEnabled && !repairBatches) {
      writeJson(checkpointPath, {
        key,
        offset,
        ...(useMssqlKeyset
          ? { mssqlKeysetAfter: keysetIdForCheckpoint(mssqlKeysetAfter) }
          : { mssqlKeysetAfter: null }),
        completed: false,
        updatedAt: new Date().toISOString(),
      });
    }
    const isLastPage = repairBatches
      ? repairBatchIndex >= repairBatches.length
      : shouldStopMigratePagination({
          advance,
          pageSize,
          rowsReadInWindow: total,
          plannedRows,
          migrationConfig,
          indexLimited: idx.indexLimited,
        });
    if (progressEnabled) {
      renderProgress(
        total,
        progressTotal,
        progressStartedAt,
        chunkIndex,
        plannedChunks,
        uiState,
      );
    } else {
      const rowMsg =
        advance === n
          ? `${advance} rows`
          : `${advance} rows advanced (${n} detail rows)`;
      console.error(
        `... [${key}] chunk ${chunkIndex} ok: ${rowMsg}, total ${total} (offset=${offset}) | chunk_ms=${lastChunkProcessMs} mssql_fetch_ms=${fetchElapsedMs}`,
      );
    }
    for (let i = 0; i < arrays.length; i++) arrays[i].length = 0;
    rows.length = 0;
    if (isLastPage) break;
  }

  if (progressEnabled) endProgress(uiState);

  await syncAppointmentIdSequence(pgClient);

  if (checkpointEnabled) {
    writeJson(checkpointPath, {
      key,
      offset,
      ...(useMssqlKeyset
        ? { mssqlKeysetAfter: keysetIdForCheckpoint(mssqlKeysetAfter) }
        : { mssqlKeysetAfter: null }),
      completed: true,
      updatedAt: new Date().toISOString(),
    });
  }

  let fieldIssueLogWritten = null;
  if (fieldIssueAcc.totalFieldIssueCount > 0) {
    const payload = buildFieldIssueLogPayload(fieldIssueAcc, {
      migrationKey: key,
      logType: "appointment_field_issues",
      recordIdKey: "schedule_id",
      buildRecord: (rec) => ({
        schedule_id: String(rec.schedule_id),
        schedule_id_raw: rec.schedule_id_raw ?? String(rec.schedule_id),
        pid: rec.pid ?? null,
        patient_info_id: rec.patient_info_id ?? null,
        fieldIssues: rec.fieldIssues ?? [],
      }),
    });
    writeFieldIssueLogFile(fieldIssueLogPath, payload);
    fieldIssueLogWritten = fieldIssueLogPath;
  }

  const repairSummary =
    repairSourceIds != null
      ? finalizeRepairFromLog(key, REPAIR_SPEC_APPOINTMENT, repairSourceIds, {
          failedIds: failedScheduleIdSet,
          notFoundInSourceIds: repairNotFoundInSource,
          fieldIssueAcc,
        })
      : null;

  const summary = {
    key,
    totalRowsRead: total,
    fieldIssueLogPath: fieldIssueLogWritten,
    checkpointPath: checkpointEnabled ? checkpointPath : null,
    chunkCount: chunkIndex,
    successChunkCount,
    failedChunkCount,
    chunkLogMode,
    chunkSampleEvery,
    chunkResults,
    repairSummary,
  };
  console.error(`>>> [${key}] done, total rows read: ${total}`);
  return summary;
}

async function main() {
  const configPath = path.resolve(process.cwd(), getConfigPath());
  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const config = resolveRuntimeConfig(rawConfig, "appointment");

  const migrationForJob = {
    ...mergeMigrationWithCli(config?.migration, "appointment"),
    batchSize:
      config.migration?.batchSize != null &&
      String(config.migration.batchSize).trim() !== ""
        ? Number(config.migration.batchSize)
        : 2000,
  };

  if (!config?.source) throw new Error("Missing source config");
  if (!config?.target) throw new Error("Missing target config");
  if (config.__profileName) {
    console.error(`>>> using config profile: ${config.__profileName}`);
  }
  assertMssqlSourceReady(config.source);

  const mssqlConfig = buildMssqlConfig(config.source);
  if (!mssqlConfig.server || !mssqlConfig.database || !mssqlConfig.user) {
    throw new Error(
      "source config is incomplete: require server/database/user (or mssqlUrl)",
    );
  }

  const pgPool = new pg.Pool({
    host: config.target.postgresHost,
    port: Number(config.target.postgresPort ?? 5432),
    user: config.target.postgresUser,
    password: config.target.postgresPassword,
    database: config.target.postgresDatabase ?? "bisinfo_dev_clone",
    max: 5,
  });

  const logsDir = path.resolve(__dirname, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const runLog = {
    startedAt: new Date().toISOString(),
    status: "running",
    tableResults: [],
    error: null,
  };

  const pool = await sql.connect(mssqlConfig);
  try {
    const client = await pgPool.connect();
    try {
      const result = await runAppointmentTableJob({
        mssqlPool: pool,
        pgClient: client,
        migrationConfig: migrationForJob,
        source: config.source,
      });
      runLog.tableResults.push(result);
      runLog.status = "success";
    } finally {
      client.release();
    }
  } catch (err) {
    runLog.status = "failed";
    runLog.error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    await pool.close();
    await pgPool.end();
    runLog.finishedAt = new Date().toISOString();
    const logPath = path.join(logsDir, `migrate-${nowStamp()}.json`);
    fs.writeFileSync(logPath, `${JSON.stringify(runLog, null, 2)}\n`, "utf8");
    console.error(`>>> migration log saved: ${logPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
