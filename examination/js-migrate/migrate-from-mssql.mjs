import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import pg from "pg";
import {
  MSSQL_EXAMINATION_DETAIL_BY_IDS_SELECT,
  MSSQL_EXAMINATION_ID_SELECT,
  MSSQL_EXAMINATION_SELECT,
} from "./mssqlExaminationSelect.mjs";
import {
  ensureExaminationOldExamIdIndex,
  ensureExaminationStagingDdl,
} from "./examinationPgDdl.mjs";
import {
  buildFieldIssueLogPayload,
  createFieldIssueAccumulator,
  getField,
  mergeFieldIssueChunk,
  normExamId,
  countExaminationTargetRows,
  resetExaminationIdSequenceIfEmpty,
  runExaminationChunkPostLoad,
  syncExaminationIdSequenceOnce,
  writeFieldIssueLogFile,
} from "./examinationMapping.mjs";
import {
  createUiState,
  endProgress,
  formatSec,
  markProgressInline,
  renderProgress,
  writeOutLine,
} from "../../shared/js-migrate/progressUi.mjs";
import {
  readNumericSourceKeyBounds,
  bindMigrateSrcNumericRange,
} from "../../shared/js-migrate/migrateCliArgs.mjs";
import {
  logByIdMigrationRun,
  plannedProgressForSourceIds,
} from "../../shared/js-migrate/sourceIdsSupport.mjs";
import { mergeMigrationWithCli } from "../../shared/js-migrate/mergeMigrationConfig.mjs";
import {
  applySourceIndexToMigrateJob,
  buildIndexCheckpointSuffix,
  isIndexWindowComplete,
  narrowPlannedRowsForIndex,
  resolvePageSize,
} from "../../shared/js-migrate/sourceIndexRange.mjs";
import { maybeEmitSourceCount } from "../../shared/js-migrate/sourceCountSnapshot.mjs";
import { fetchMssqlRowsByIds } from "../../shared/js-migrate/fetchMssqlByIds.mjs";
import {
  batchIds,
  resolveMigrationSourceIds,
} from "../../shared/js-migrate/repairFromLog.mjs";
import {
  finalizeRepairFromLog,
  noteRepairBatchNotFoundInSource,
} from "../../shared/js-migrate/repairSummary.mjs";
import { REPAIR_SPEC_EXAMINATION } from "../../shared/js-migrate/migrateTableSpecs.mjs";
import { examinationExamNumericRangePredicate } from "../../shared/js-migrate/migrateMssqlBindings.mjs";
import {
  isLastKeysetPage,
  optionalDetailRowCount,
  resolveKeysetAdvance,
} from "../../shared/js-migrate/twoStepKeyset.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAM_NUMERIC_KEY_RANGE_PRED = examinationExamNumericRangePredicate();
const MSSQL_EXAM_ID_NUMERIC_EXPR = "[Exam_ID]";

/**
 * อ่าน dbo.examination แบบ keyset: `WHERE [Exam_ID] > @after` แทน `OFFSET` — OFFSET นับแถว O(n) พอ data เยอะ
 * ยิ่ง offset สูงยิ่งช้า; keyset ใช้ index seek รายหน้าได้นานเสมอ
 */
function buildMssqlExaminationKeysetSelect() {
  const marker = "FROM {{sourceObject}}";
  const s = MSSQL_EXAMINATION_SELECT;
  const idx = s.indexOf(marker);
  if (idx < 0) {
    throw new Error("MSSQL_EXAMINATION_SELECT: missing FROM {{sourceObject}}");
  }
  const head = s.slice(0, idx).trimEnd();
  // Use TOP(@page) for keyset pagination to avoid OFFSET/FETCH overhead on large tables.
  const headWithTop = head.replace(/^SELECT\s*/i, "SELECT TOP (@page) ");
  return `${headWithTop},
  ${MSSQL_EXAM_ID_NUMERIC_EXPR} AS __mssql_exam_id
FROM {{sourceObject}}
WHERE ${MSSQL_EXAM_ID_NUMERIC_EXPR} > @afterExamId AND (${EXAM_NUMERIC_KEY_RANGE_PRED})
ORDER BY ${MSSQL_EXAM_ID_NUMERIC_EXPR} ASC;`;
}

function buildMssqlExaminationProbeSelect() {
  return MSSQL_EXAMINATION_ID_SELECT.replace("AS exam_id", "AS probe_exam_id");
}

function buildMssqlExaminationDetailByIdsSelect(idPlaceholders) {
  return MSSQL_EXAMINATION_DETAIL_BY_IDS_SELECT.replace(
    "{{idPlaceholders}}",
    idPlaceholders,
  );
}

async function filterExamFetchRowsInsertOnly(pgClient, rows) {
  const cand = Array.from(
    new Set(
      rows
        .map((r) => normExamId(getField(r, "exam_id")))
        .filter((id) => id !== "" && /^[0-9]+$/.test(id)),
    ),
  );
  if (cand.length === 0) return [];
  const { rows: existRows } = await pgClient.query(
    `SELECT old_exam_id::text AS eid FROM public.examination WHERE old_exam_id::text = ANY($1::text[])`,
    [cand],
  );
  const have = new Set(existRows.map((r) => String(r.eid)));
  return rows.filter((r) => {
    const id = normExamId(getField(r, "exam_id"));
    if (id === "" || !/^[0-9]+$/.test(id)) return true;
    return !have.has(id);
  });
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
  return v;
}

const EXAMINATION_COLUMNS = [
  "exam_id",
  "exam_date",
  "pid",
  "tech_login_name",
  "mobile",
  "mobile_update",
  "menstruation_age",
  "menopause_age",
  "first_pregnancy_age",
  "num_pregnancy",
  "cont_use",
  "cont_yrs",
  "hormone_use",
  "hormone_yrs",
  "hysterectomy",
  "ovaries_removed",
  "pragnant",
  "referring_md",
  "referring_hospital",
  "prev_mammo_date",
  "prev_mammo_loc",
  "sister_cancer_age",
  "mother_cancer_age",
  "grandmother_cancer_age",
  "other_cancer_age",
  "biopsy_l_date",
  "biopsy_r_date",
  "chemo_l_date",
  "chemo_r_date",
  "cyst_l_date",
  "cyst_r_date",
  "irr_l_date",
  "irr_r_date",
  "lump_l_date",
  "lump_r_date",
  "mast_l_date",
  "mast_r_date",
  "rad_l_date",
  "rad_r_date",
  "num_left_mass",
  "num_right_mass",
  "lnwn",
  "lnww",
  "ln",
  "lnen",
  "lnee",
  "le",
  "lm",
  "lw",
  "lsws",
  "lsww",
  "ls",
  "lses",
  "lsee",
  "rnwn",
  "rnww",
  "rn",
  "rnen",
  "rnee",
  "re",
  "rm",
  "rw",
  "rsws",
  "rsww",
  "rs",
  "rses",
  "rsee",
  "lother",
  "rother",
  "l_axillar",
  "r_axillar",
  "exam_reason",
  "exam_reason_text",
  "exam_reason_memotext",
  "pain_l_duration",
  "pain_r_duration",
  "mobile_updated",
  "mobile_loc",
  "bct_r_date",
  "bct_l_date",
  "patient_cancer_age",
  "daughter_cancer_age",
  "daughter_cancer_age_more",
  "sister_cancer_age_more",
  "other_cancer_age_more",
  "stophormone_yrs",
  "ca_hormone_use",
  "ca_hormone_yrs",
  "stop_ca_hormone_yrs",
  "stop_contr_yrs",
  "rm_l_date",
  "rm_r_date",
  "ri_l_date",
  "ri_r_date",
  "fna_l_date",
  "fna_r_date",
  "fnx_l_date",
  "fnx_r_date",
  "send_exam_login_name",
  "schedule_id",
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
  return new Date().toISOString().replace(/[:.]/g, "-");
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

/**
 * Tedious: requestTimeout สั้น (ดีฟอลต์ 15s) ทำให้ batch ข้อมูลมหาศาล fail
 * - requestTimeout: 0 = ไม่จำกัดเวลา request (แนะนำสำหรับ one-off migration)
 * - หมดเวลาแล้ว driver จะ cancel: ถ้า cancel ช้า จะ error "Failed to cancel in 5000ms" — ตั้ง cancelTimeout: 0
 *   เพื่อไม่ให้บังคับ timeout รอ cancel (กัน error นี้เมื่อ requestTimeout > 0)
 */
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
  const profileConfig = rawConfig.profiles[selectedProfile];
  if (!profileConfig) {
    throw new Error(
      `Profile '${selectedProfile}' not found in config.profiles`,
    );
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
    tables: profileConfig.tables ?? shared.tables,
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
      "MSSQL: กำหนด source.password ใน migration.config.local.json (shared หรือ profile) ให้เป็นรหัสจริง — ยังใช้ placeholder YOUR_MSSQL_PASSWORD หรือเว้นว่างอยู่",
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
    const v = getField(row, k);
    return v === undefined || v === null ? null : toStr(v);
  };
  for (let c = 0; c < cols.length; c++) arrays[c][rowIdx] = g(cols[c]);
}

function readSql(baseDir, relativePath) {
  const fullPath = path.resolve(baseDir, relativePath);
  return fs.readFileSync(fullPath, "utf8");
}

function readJsonIfExists(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) return fallbackValue;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function stripTxWrappers(sqlText) {
  return sqlText
    .replace(/^\s*BEGIN\s*;\s*/im, "")
    .replace(/\s*COMMIT\s*;\s*$/im, "");
}

function bracketIdent(value) {
  return `[${String(value).replace(/]/g, "]]")}]`;
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
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

function buildTableJobs(config) {
  if (Array.isArray(config.tables) && config.tables.length > 0)
    return config.tables;
  return [
    {
      key: "examination",
      sourceSchema: config.source?.schema ?? "dbo",
      sourceTable: config.source?.table ?? "examination",
      orderBy: "[Exam_ID] ASC",
      stagingTable: "migrate_stg.examination_mssql",
      columns: EXAMINATION_COLUMNS,
      postLoadSqlFiles: [],
    },
  ];
}

async function runTableJob({
  mssqlPool,
  pgClient,
  sqlBaseDir,
  migrationConfig,
  tableJob,
}) {
  const key =
    tableJob.key ?? `${tableJob.sourceSchema}.${tableJob.sourceTable}`;
  const sourceSchema = tableJob.sourceSchema ?? "dbo";
  const sourceTable = tableJob.sourceTable;
  const columns = tableJob.columns ?? [];
  const stagingTable = tableJob.stagingTable;
  const selectSqlFile = tableJob.selectSqlFile ?? null;
  const orderBy = tableJob.orderBy ?? "[Exam_ID]";
  const batchSize = Math.max(
    50,
    Math.min(
      5000,
      Number(tableJob.batchSize ?? migrationConfig.batchSize ?? 500),
    ),
  );
  const checkpointEnabled = migrationConfig.enableCheckpoint !== false;
  const checkpointDir = path.resolve(
    sqlBaseDir,
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
  const isExaminationBuiltin = (() => {
    const jobKey = (tableJob.key ?? "").toString().toLowerCase();
    const st = (tableJob.sourceTable ?? "").toString().toLowerCase();
    return jobKey === "examination" || st === "examination";
  })();

  if (!sourceTable || !stagingTable || columns.length === 0) {
    throw new Error(`Table job '${key}' is incomplete`);
  }
  if (!selectSqlFile && !isExaminationBuiltin) {
    throw new Error(
      `Table job '${key}' is incomplete: set selectSqlFile or use key/sourceTable examination for built-in SELECT`,
    );
  }

  const stagingFromClause = (() => {
    const t = String(stagingTable).trim();
    if (!/^\w+\.\w+$/.test(t)) {
      throw new Error(
        `Table job '${key}': stagingTable ต้องเป็นรูป schema.table (a-z, 0-9, _): ได้ "${stagingTable}"`,
      );
    }
    return t;
  })();

  const sourceObject = `${bracketIdent(sourceSchema)}.${bracketIdent(sourceTable)}`;
  const sourceObjectNoLock = `${sourceObject} WITH (NOLOCK)`;
  const useMssqlKeysetBase =
    isExaminationBuiltin &&
    !selectSqlFile &&
    (tableJob.useMssqlKeyset === undefined || tableJob.useMssqlKeyset === true);

  const checkpoint = readJsonIfExists(checkpointPath, {
    key,
    offset: 0,
    completed: false,
    updatedAt: null,
  });
  let offset = Number(
    tableJob.startOffset ?? (checkpointEnabled ? checkpoint.offset : 0),
  );
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  let useMssqlKeyset = useMssqlKeysetBase;
  if (useMssqlKeyset && offset > 0 && checkpoint.mssqlKeysetAfter == null) {
    useMssqlKeyset = false;
    console.error(
      `>>> [${key}] resume: ใช้ OFFSET (checkpoint เก่า) — รอบนี้จะช้า; ลบไฟล์ checkpoint แล้วรันตั้งแต่ 0 จะใช้ keyset เร็วกว่า`,
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

  const selectSql = (() => {
    const tpl = selectSqlFile
      ? readSql(sqlBaseDir, selectSqlFile)
      : useMssqlKeyset
        ? buildMssqlExaminationKeysetSelect()
        : MSSQL_EXAMINATION_SELECT;
    let out = tpl
      .replaceAll("{{sourceObject}}", sourceObjectNoLock)
      .replaceAll("{{orderBy}}", orderBy);
    if (out.includes("{{examNumericKeyRange}}")) {
      out = out.replaceAll(
        "{{examNumericKeyRange}}",
        EXAM_NUMERIC_KEY_RANGE_PRED,
      );
    }
    return out;
  })();
  const probeSql = (() => {
    let p = buildMssqlExaminationProbeSelect().replaceAll(
      "{{sourceObject}}",
      sourceObjectNoLock,
    );
    if (p.includes("{{examNumericKeyRange}}")) {
      p = p.replaceAll("{{examNumericKeyRange}}", EXAM_NUMERIC_KEY_RANGE_PRED);
    }
    return p;
  })();

  let mssqlKeysetAfter = checkpoint.mssqlKeysetAfter;
  if (useMssqlKeyset && mssqlKeysetAfter == null) mssqlKeysetAfter = -1;
  if (!useMssqlKeyset) mssqlKeysetAfter = null;
  if (useMssqlKeyset && kb.min != null) {
    const floorExclusive = kb.min - 1n;
    const curBi = toBigIntish(mssqlKeysetAfter);
    if (curBi < floorExclusive) {
      console.error(
        `>>> [${key}] ปรับ keyset ให้ครอบ sourceKeyNumericMin (${kb.min})`,
      );
      mssqlKeysetAfter = bigIntToJsKeysetValue(floorExclusive);
    }
  }
  if (
    migrationConfig.migrateRowMode === "insert-only" &&
    isExaminationBuiltin
  ) {
    console.error(
      `>>> [${key}] migrateRowMode=insert-only (ไม่ DELETE/แทนที่ examination ที่มี old_exam_id อยู่แล้ว)`,
    );
  } else if (isExaminationBuiltin && (kb.min != null || kb.max != null)) {
    console.error(
      `>>> [${key}] source key numeric range: min=${kb.min ?? "unset"} max=${kb.max ?? "unset"}`,
    );
  }

  console.error(
    `>>> [${key}] start offset: ${offset}${useMssqlKeyset ? " (MSSQL keyset ตาม [Exam_ID])" : ""}`,
  );

  if (isExaminationBuiltin && toArray(tableJob.preLoadSqlFiles).length === 0) {
    console.error(
      `>>> [${key}] ensure migrate_stg + norm functions (built-in JS DDL)`,
    );
    await ensureExaminationStagingDdl(pgClient);
    await ensureExaminationOldExamIdIndex(pgClient);
    await resetExaminationIdSequenceIfEmpty(pgClient);
  }
  for (const sqlFile of toArray(tableJob.preLoadSqlFiles)) {
    console.error(`>>> [${key}] run pre-load SQL: ${sqlFile}`);
    await pgClient.query(readSql(sqlBaseDir, sqlFile));
  }

  let total = 0;
  let sourceCases = 0;
  let examinationSuccessCases = 0;
  let examinationFailCases = 0;
  const failedExamIdSet = new Set();
  const fieldIssueAcc = isExaminationBuiltin
    ? createFieldIssueAccumulator()
    : null;
  const fieldIssueLogPath = isExaminationBuiltin
    ? path.join(
        path.resolve(__dirname, "logs"),
        `migration-field-issues-${String(key).replace(/[^a-zA-Z0-9_-]/g, "_")}-${nowStamp()}.json`,
      )
    : null;
  const chunkResults = [];
  let chunkIndex = 0;
  let successChunkCount = 0;
  let failedChunkCount = 0;
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
  const probeTiming = migrationConfig.probeTiming === true;
  const debugLogs = migrationConfig.debugLogs === true || probeTiming;
  const uiState = createUiState();
  let plannedRows = sourceLimit;
  if (plannedRows == null && progressEnabled) {
    try {
      const countReq = mssqlPool.request();
      if (probeSql.includes("@migrateSrcKeyMin")) {
        bindMigrateSrcNumericRange(countReq, migrationConfig, sql);
        const countRes = await countReq.query(
          `SELECT COUNT_BIG(1) AS total FROM ${sourceObjectNoLock} WHERE (${EXAM_NUMERIC_KEY_RANGE_PRED});`,
        );
        plannedRows = Number(countRes.recordset?.[0]?.total ?? 0);
      } else {
        const countRes = await countReq.query(
          `SELECT COUNT_BIG(1) AS total FROM ${sourceObjectNoLock};`,
        );
        plannedRows = Number(countRes.recordset?.[0]?.total ?? 0);
      }
    } catch {
      plannedRows = null;
    }
  }
  if (idx.indexLimited) {
    plannedRows = narrowPlannedRowsForIndex({
      plannedRows,
      offset,
      sourceIndexFrom: idx.sourceIndexFrom,
      sourceIndexTo: idx.sourceIndexTo,
    });
  }
  maybeEmitSourceCount(plannedRows);
  let progressTotal = plannedRows ?? null;
  let plannedChunks =
    plannedRows != null && plannedRows > 0
      ? Math.ceil(plannedRows / batchSize)
      : null;
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

  const logsDir = path.resolve(__dirname, "logs");
  const repairSourceIds = isExaminationBuiltin
    ? resolveMigrationSourceIds(
        migrationConfig,
        logsDir,
        REPAIR_SPEC_EXAMINATION,
      )
    : null;
  const repairBatches =
    repairSourceIds != null ? [...batchIds(repairSourceIds, batchSize)] : null;
  let repairBatchIndex = 0;
  const repairNotFoundInSource = repairSourceIds != null ? new Set() : null;
  if (repairSourceIds != null && repairSourceIds.length === 0) {
    console.error(`>>> [${key}] repair-from-log: ไม่มี id ให้ migrate`);
    return {
      key,
      totalRowsRead: 0,
      source_cases: 0,
      examination_success_cases: 0,
      examination_fail_cases: 0,
      failedExamIds: [],
      fieldIssueLogPath: null,
      missingByReason: [],
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
      "exam_id",
      migrationConfig,
    );
  }

  if (isExaminationBuiltin && repairSourceIds == null) {
    const targetRowCount = await countExaminationTargetRows(pgClient);
    if (targetRowCount === 0) {
      const keysetAfterNum =
        mssqlKeysetAfter == null ? -1 : Number(mssqlKeysetAfter);
      const hadCheckpointProgress =
        offset > 0 ||
        (useMssqlKeyset &&
          Number.isFinite(keysetAfterNum) &&
          keysetAfterNum > -1) ||
        checkpoint.completed === true;
      offset = 0;
      if (useMssqlKeyset) mssqlKeysetAfter = -1;
      await resetExaminationIdSequenceIfEmpty(pgClient);
      if (checkpointEnabled) {
        writeJson(checkpointPath, {
          key,
          offset: 0,
          ...(useMssqlKeyset
            ? { mssqlKeysetAfter: keysetIdForCheckpoint(-1) }
            : { mssqlKeysetAfter: null }),
          completed: false,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  while (true) {
    const pageSize = resolvePageSize({
      batchSize,
      total,
      sourceLimit,
      plannedRows: idx.indexLimited ? plannedRows : null,
    });
    if (pageSize <= 0) break;
    const nextChunkIndex = chunkIndex + 1;
    if (debugLogs && !singleLineUi && useMssqlKeyset) {
      writeOutLine(
        `>>> [${key}] fetch chunk ${nextChunkIndex}: afterExamId=${String(mssqlKeysetAfter)} pageSize=${pageSize}`,
        uiState,
      );
    } else if (debugLogs && !singleLineUi) {
      writeOutLine(
        `>>> [${key}] fetch chunk ${nextChunkIndex}: offset=${offset} pageSize=${pageSize}`,
        uiState,
      );
    }

    if (probeTiming && useMssqlKeyset) {
      const probeStartedAt = Date.now();
      const pReq = mssqlPool.request();
      if (probeSql.includes("@migrateSrcKeyMin")) {
        bindMigrateSrcNumericRange(pReq, migrationConfig, sql);
      }
      const probe = await pReq
        .input("afterExamId", sql.BigInt, toBigIntish(mssqlKeysetAfter))
        .input("page", sql.Int, Math.min(pageSize, 50))
        .query(probeSql);
      const probeElapsedMs = Date.now() - probeStartedAt;
      const probeRows = probe.recordset || [];
      const probeFirst =
        probeRows.length > 0 ? String(probeRows[0].probe_exam_id) : "none";
      const probeLast =
        probeRows.length > 0
          ? String(probeRows[probeRows.length - 1].probe_exam_id)
          : "none";
      if (!singleLineUi) {
        console.error(
          `>>> [${key}] probe exam_id ok: rows=${probeRows.length} first=${probeFirst} last=${probeLast} probe_ms=${probeElapsedMs}`,
        );
      }
    }

    let rows = [];
    /** @type {any[]} */
    let idRows = [];
    let lastExamIdFromProbe = null;
    let fetchElapsedMs = 0;
    let idFetchElapsedMs = 0;
    let detailFetchElapsedMs = 0;

    if (repairBatches) {
      if (repairBatchIndex >= repairBatches.length) break;
      const idBatch = repairBatches[repairBatchIndex++];
      const detailFetchStartedAt = Date.now();
      rows = await fetchMssqlRowsByIds(mssqlPool, sql, {
        ids: idBatch,
        detailSqlTemplate: buildMssqlExaminationDetailByIdsSelect(
          "{{idPlaceholders}}",
        ).replaceAll("{{sourceObject}}", sourceObjectNoLock),
      });
      detailFetchElapsedMs = Date.now() - detailFetchStartedAt;
      fetchElapsedMs = detailFetchElapsedMs;
      lastExamIdFromProbe = idBatch[idBatch.length - 1];
      idRows = idBatch.map((id) => ({ probe_exam_id: id }));
      if (repairNotFoundInSource) {
        noteRepairBatchNotFoundInSource(
          repairNotFoundInSource,
          idBatch,
          rows,
          (r) => normExamId(getField(r, "exam_id")),
        );
      }
      if (rows.length === 0) continue;
    } else if (isExaminationBuiltin && useMssqlKeyset) {
      // Step 1: fetch lightweight Exam_ID list (keyset).
      const idFetchStartedAt = Date.now();
      const idReq = mssqlPool.request();
      if (probeSql.includes("@migrateSrcKeyMin")) {
        bindMigrateSrcNumericRange(idReq, migrationConfig, sql);
      }
      const idResp = await idReq
        .input("afterExamId", sql.BigInt, toBigIntish(mssqlKeysetAfter))
        .input("page", sql.Int, pageSize)
        .query(probeSql);
      idFetchElapsedMs = Date.now() - idFetchStartedAt;
      idRows = idResp.recordset || [];
      if (idRows.length > 0) {
        lastExamIdFromProbe = idRows[idRows.length - 1].probe_exam_id;
      }
      if (probeTiming && !singleLineUi) {
        const idFirst =
          idRows.length > 0 ? String(idRows[0].probe_exam_id) : "none";
        const idLast =
          idRows.length > 0
            ? String(idRows[idRows.length - 1].probe_exam_id)
            : "none";
        writeOutLine(
          `>>> [${key}] id fetch ok: rows=${idRows.length} first=${idFirst} last=${idLast} id_fetch_ms=${idFetchElapsedMs}`,
          uiState,
        );
      }
      if (idRows.length === 0) {
        rows = [];
        fetchElapsedMs = idFetchElapsedMs;
      } else {
        // Step 2: fetch full detail for that ID chunk.
        const idPlaceholders = idRows.map((_, i) => `@id${i}`).join(", ");
        const detailSql = buildMssqlExaminationDetailByIdsSelect(
          idPlaceholders,
        ).replaceAll("{{sourceObject}}", sourceObjectNoLock);
        const detailReq = mssqlPool.request();
        idRows.forEach((r, i) => {
          detailReq.input(`id${i}`, sql.BigInt, toBigIntish(r.probe_exam_id));
        });
        const detailFetchStartedAt = Date.now();
        const detailResp = await detailReq.query(detailSql);
        detailFetchElapsedMs = Date.now() - detailFetchStartedAt;
        rows = detailResp.recordset || [];
        fetchElapsedMs = idFetchElapsedMs + detailFetchElapsedMs;
        if (probeTiming && !singleLineUi) {
          writeOutLine(
            `>>> [${key}] detail fetch ok: rows=${rows.length} detail_fetch_ms=${detailFetchElapsedMs}`,
            uiState,
          );
        }
      }
    } else {
      const fetchStartedAt = Date.now();
      const fq = mssqlPool.request();
      if (selectSql.includes("@migrateSrcKeyMin")) {
        bindMigrateSrcNumericRange(fq, migrationConfig, sql);
      }
      const r = useMssqlKeyset
        ? await fq
            .input("afterExamId", sql.BigInt, toBigIntish(mssqlKeysetAfter))
            .input("page", sql.Int, pageSize)
            .query(selectSql)
        : await fq
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
    if (rows.length === 0) break;

    const keysetAdvance = resolveKeysetAdvance(
      isExaminationBuiltin && useMssqlKeyset ? idRows.length : null,
      rows.length,
    );
    let stagingRows = rows;
    if (
      isExaminationBuiltin &&
      (migrationConfig.migrateRowMode ?? "overwrite") === "insert-only"
    ) {
      stagingRows = await filterExamFetchRowsInsertOnly(pgClient, rows);
    }

    const n = stagingRows.length;
    chunkIndex += 1;

    /** chunk จาก MSSQL หมดชุดแล้วทุก exam มีอยู่แล้ว (insert-only) — ข้าม TX แต่ต้อง advance keyset/checkpoint */
    if (n === 0) {
      total += keysetAdvance;
      if (!repairBatches) {
        offset += keysetAdvance;
        if (useMssqlKeyset) {
          mssqlKeysetAfter =
            lastExamIdFromProbe ??
            toBigIntish(normExamId(rows[rows.length - 1]?.exam_id));
        }
        if (checkpointEnabled) {
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
      }
      if (progressEnabled) {
        renderProgress(
          total,
          progressTotal,
          progressStartedAt,
          chunkIndex,
          plannedChunks,
          uiState,
        );
      }
      rows.length = 0;
      const emptyLast = repairBatches
        ? repairBatchIndex >= repairBatches.length
        : isLastKeysetPage(keysetAdvance, pageSize);
      if (emptyLast) break;
      continue;
    }

    const chunkStartedAt = Date.now();
    const sourceOffsetStart = offset;
    const sourceOffsetEnd = offset + keysetAdvance - 1;
    const firstExamId = normExamId(stagingRows[0]?.exam_id);
    const lastExamId = normExamId(stagingRows[n - 1]?.exam_id);
    const arrays = columns.map(() => new Array(n));
    for (let i = 0; i < n; i++)
      rowToStagingArrays(stagingRows[i], i, arrays, columns);

    let step = "begin chunk transaction";
    let txBeginMs = 0;
    let truncateMs = 0;
    let stagingInsertMs = 0;
    let postLoadMs = 0;
    let statsMs = 0;
    let commitMs = 0;
    try {
      const txBeginStartedAt = Date.now();
      await pgClient.query("BEGIN");
      txBeginMs = Date.now() - txBeginStartedAt;
      step = "truncate staging table";
      const truncateStartedAt = Date.now();
      await pgClient.query(`TRUNCATE TABLE ${stagingTable};`);
      truncateMs = Date.now() - truncateStartedAt;

      step = "insert chunk into staging";
      const stagingInsertStartedAt = Date.now();
      const unnestArgs = arrays
        .map((_, idx) => `$${idx + 1}::text[]`)
        .join(", ");
      const insertStaging = `INSERT INTO ${stagingTable} (${columns.join(", ")}) SELECT * FROM unnest(${unnestArgs});`;
      await pgClient.query(insertStaging, arrays);
      stagingInsertMs = Date.now() - stagingInsertStartedAt;

      if (toArray(tableJob.postLoadSqlFiles).length > 0) {
        const postLoadStartedAt = Date.now();
        if (isExaminationBuiltin) {
          console.error(
            `>>> [${key}] คำเตือน: ตั้ง postLoadSqlFiles แล้ว จะไม่รันแมป JS ไป public.examination; เอา postLoadSqlFiles ออกถ้าต้องการแมปแบบ built-in`,
          );
        }
        for (const sqlFile of toArray(tableJob.postLoadSqlFiles)) {
          step = `run post-load SQL: ${sqlFile}`;
          console.error(`>>> [${key}] run post-load SQL: ${sqlFile}`);
          const postSql = stripTxWrappers(readSql(sqlBaseDir, sqlFile));
          await pgClient.query(postSql);
        }
        postLoadMs = Date.now() - postLoadStartedAt;
      } else if (isExaminationBuiltin) {
        step = "run examination JS post-load (map -> public.examination)";
        if (debugLogs && !singleLineUi) {
          console.error(`>>> [${key}] runExaminationChunkPostLoad`);
        }
        const postLoadStartedAt = Date.now();
        const postLoadResult = await runExaminationChunkPostLoad(
          pgClient,
          stagingRows,
          stagingFromClause,
          {
            verbose: debugLogs && !singleLineUi,
            migrationKey: key,
            chunkIndex,
            migrateRowMode: migrationConfig.migrateRowMode ?? "overwrite",
          },
        );
        mergeFieldIssueChunk(fieldIssueAcc, postLoadResult);
        for (const eid of postLoadResult?.failedExamIds ?? [])
          failedExamIdSet.add(eid);
        postLoadMs = Date.now() - postLoadStartedAt;
      }

      step = "compute chunk stats";
      const statsStartedAt = Date.now();
      const stats = await pgClient.query(`
WITH src AS (
  SELECT DISTINCT migrate_stg.norm_exam_id(exam_id) AS nexam
  FROM ${stagingFromClause}
  WHERE NULLIF(migrate_stg.norm_exam_id(exam_id), '') ~ '^[0-9]+$'
),
matched AS (
  SELECT DISTINCT e.old_exam_id AS nexam
  FROM public.examination e
  JOIN src s ON s.nexam = e.old_exam_id
)
SELECT
  (SELECT COUNT(*)::int FROM src) AS source_cases,
  (SELECT COUNT(*)::int FROM matched) AS examination_success_cases,
  ((SELECT COUNT(*)::int FROM src) - (SELECT COUNT(*)::int FROM matched)) AS examination_fail_cases;
`);

      const failedRows = await pgClient.query(`
WITH src AS (
  SELECT DISTINCT migrate_stg.norm_exam_id(exam_id) AS nexam
  FROM ${stagingFromClause}
  WHERE NULLIF(migrate_stg.norm_exam_id(exam_id), '') ~ '^[0-9]+$'
),
matched AS (
  SELECT DISTINCT e.old_exam_id AS nexam
  FROM public.examination e
  JOIN src s ON s.nexam = e.old_exam_id
)
SELECT s.nexam AS exam_id
FROM src s
LEFT JOIN matched m ON m.nexam = s.nexam
WHERE m.nexam IS NULL
ORDER BY s.nexam
LIMIT 200;
`);
      statsMs = Date.now() - statsStartedAt;

      const chunkStats = stats.rows[0] ?? {};
      sourceCases += Number(chunkStats.source_cases ?? 0);
      examinationSuccessCases += Number(
        chunkStats.examination_success_cases ?? 0,
      );
      examinationFailCases += Number(chunkStats.examination_fail_cases ?? 0);
      for (const row of failedRows.rows) {
        if (failedExamIdSet.size >= 200) break;
        failedExamIdSet.add(row.exam_id);
      }

      const commitStartedAt = Date.now();
      await pgClient.query("COMMIT");
      commitMs = Date.now() - commitStartedAt;
      successChunkCount += 1;
      const totalChunkMs = Date.now() - chunkStartedAt;
      const chunkResult = {
        chunkIndex,
        status: "success",
        sourceOffsetStart,
        sourceOffsetEnd,
        rowCount: keysetAdvance,
        ...optionalDetailRowCount(keysetAdvance, rows.length),
        stagingRowCount: n,
        firstExamId,
        lastExamId,
        source_cases: Number(chunkStats.source_cases ?? 0),
        examination_success_cases: Number(
          chunkStats.examination_success_cases ?? 0,
        ),
        examination_fail_cases: Number(chunkStats.examination_fail_cases ?? 0),
        timings: {
          fetchMs: fetchElapsedMs,
          idFetchMs: idFetchElapsedMs,
          detailFetchMs: detailFetchElapsedMs,
          txBeginMs,
          truncateMs,
          stagingInsertMs,
          postLoadMs,
          statsMs,
          commitMs,
          totalChunkMs,
          rowsPerSec:
            totalChunkMs > 0
              ? Number(((n * 1000) / totalChunkMs).toFixed(2))
              : null,
        },
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
      chunkResults.push({
        chunkIndex,
        status: "failed",
        sourceOffsetStart,
        sourceOffsetEnd,
        rowCount: keysetAdvance,
        ...optionalDetailRowCount(keysetAdvance, rows.length),
        stagingRowCount: n,
        firstExamId,
        lastExamId,
        failedAtStep: step,
        error: err instanceof Error ? err.message : String(err),
        timings: {
          fetchMs: fetchElapsedMs,
          idFetchMs: idFetchElapsedMs,
          detailFetchMs: detailFetchElapsedMs,
          txBeginMs,
          truncateMs,
          stagingInsertMs,
          postLoadMs,
          statsMs,
          commitMs,
          totalChunkMs: Date.now() - chunkStartedAt,
        },
      });
      throw new Error(
        `[${key}] failed chunk ${chunkIndex} (offset ${sourceOffsetStart}-${sourceOffsetEnd}, exam_id ${firstExamId}..${lastExamId}) at step '${step}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    total += keysetAdvance;
    if (!repairBatches) {
      offset += keysetAdvance;
      if (useMssqlKeyset) {
        mssqlKeysetAfter =
          lastExamIdFromProbe ??
          toBigIntish(normExamId(rows[rows.length - 1]?.exam_id));
      }
      if (checkpointEnabled) {
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
    }
    const isLastPage =
      isIndexWindowComplete({
        indexLimited: idx.indexLimited,
        plannedRows,
        rowsReadInWindow: total,
      }) ||
      (repairBatches
        ? repairBatchIndex >= repairBatches.length
        : isLastKeysetPage(keysetAdvance, pageSize));
    if (debugLogs && !singleLineUi) {
      writeOutLine(
        `>>> [${key}] chunk ${chunkIndex}/${plannedChunks ?? "?"} done ${formatSec(
          Date.now() - chunkStartedAt,
        )} (fetch ${formatSec(fetchElapsedMs)}, post ${formatSec(postLoadMs)}) keyset ${keysetAdvance}${keysetAdvance !== rows.length ? ` detail ${rows.length}` : ""} staging ${n}, total ${total}/${plannedRows ?? "?"}`,
        uiState,
      );
    }
    if (progressEnabled) {
      renderProgress(
        total,
        progressTotal,
        progressStartedAt,
        chunkIndex,
        plannedChunks,
        uiState,
      );
    }
    // Explicitly clear chunk buffers before next iteration.
    for (let i = 0; i < arrays.length; i++) arrays[i].length = 0;
    rows.length = 0;
    if (isLastPage) break;
  }

  if (progressEnabled) endProgress(uiState);

  if (isExaminationBuiltin) {
    await syncExaminationIdSequenceOnce(pgClient);
  }

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

  const missingByReason = await pgClient.query(`
SELECT reason, COUNT(*)::int AS cnt
FROM (
  SELECT
    CASE
      WHEN NULLIF(migrate_stg.norm_exam_id(s.exam_id), '') !~ '^[0-9]+$' THEN 'invalid_exam_id'
      WHEN migrate_stg.norm_pid(s.pid) = '' THEN 'empty_pid'
      WHEN NOT EXISTS (
        SELECT 1 FROM public.patient_info p
        WHERE migrate_stg.norm_pid(p.pid::text) = migrate_stg.norm_pid(s.pid)
      ) THEN 'patient_not_found'
      ELSE 'unknown'
    END AS reason
  FROM ${stagingFromClause} s
  LEFT JOIN public.examination e
    ON e.old_exam_id = CASE
      WHEN NULLIF(migrate_stg.norm_exam_id(s.exam_id), '') ~ '^[0-9]+$'
      THEN (NULLIF(migrate_stg.norm_exam_id(s.exam_id), '')::bigint)::text
      ELSE NULL
    END
  WHERE e.id IS NULL
) t
GROUP BY reason
ORDER BY reason;
`);

  let fieldIssueLogWritten = null;
  if (
    fieldIssueAcc &&
    fieldIssueLogPath &&
    (fieldIssueAcc.totalFieldIssueCount > 0 || fieldIssueAcc.masterLoadError)
  ) {
    const payload = buildFieldIssueLogPayload(fieldIssueAcc, {
      migrationKey: key,
    });
    writeFieldIssueLogFile(fieldIssueLogPath, payload);
    fieldIssueLogWritten = fieldIssueLogPath;
  }

  const repairSummary =
    repairSourceIds != null
      ? finalizeRepairFromLog(key, REPAIR_SPEC_EXAMINATION, repairSourceIds, {
          failedIds: failedExamIdSet,
          notFoundInSourceIds: repairNotFoundInSource,
          fieldIssueAcc,
        })
      : null;

  const summary = {
    key,
    totalRowsRead: total,
    source_cases: sourceCases,
    examination_success_cases: examinationSuccessCases,
    examination_fail_cases: examinationFailCases,
    failedExamIds: Array.from(failedExamIdSet),
    fieldIssueLogPath: fieldIssueLogWritten,
    missingByReason: missingByReason.rows,
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
  const config = resolveRuntimeConfig(rawConfig, "examination");

  if (!config?.source) {
    throw new Error("Missing source config");
  }
  if (!config?.target) {
    throw new Error("Missing target config");
  }
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

  const sqlBaseDir = path.resolve(__dirname);
  const tableJobs = buildTableJobs(config);
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
      for (const tableJob of tableJobs) {
        const result = await runTableJob({
          mssqlPool: pool,
          pgClient: client,
          sqlBaseDir,
          migrationConfig: mergeMigrationWithCli(
            config?.migration,
            "examination",
          ),
          tableJob,
        });
        runLog.tableResults.push(result);
      }
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
