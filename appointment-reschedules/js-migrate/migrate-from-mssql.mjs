import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import pg from "pg";
import {
  MSSQL_APPOINTMENT_RESCHEDULES_BY_LOG_KEYS_SELECT,
  MSSQL_APPOINTMENT_RESCHEDULES_OFFSET_ORDER_BY,
  MSSQL_APPOINTMENT_RESCHEDULES_SELECT,
  buildMssqlAppointmentReschedulesKeysetSelect,
} from "./mssqlAppointmentReschedulesSelect.mjs";
import { isLastKeysetPage } from "../../shared/js-migrate/twoStepKeyset.mjs";
import {
  ensureAppointmentReschedulesPipelineDdl,
  ensureAppointmentReschedulesTargetIndexes,
} from "./appointmentReschedulesPgDdl.mjs";
import {
  rescheduleLogKey,
  resetAppointmentReschedulesIdSequenceIfEmpty,
  runAppointmentReschedulesChunkPostLoad,
  syncAppointmentReschedulesIdSequence,
  warmupAppointmentReschedulesLookups,
} from "./appointmentReschedulesMapping.mjs";
import {
  buildFieldIssueLogPayload,
  createFieldIssueAccumulator,
  mergeFieldIssueChunk,
  writeFieldIssueLogFile,
} from "../../shared/js-migrate/fieldIssueLog.mjs";
import {
  createUiState,
  endProgress,
  formatSec,
  renderProgress,
  writeOutLine,
} from "../../shared/js-migrate/progressUi.mjs";
import {
  logByIdMigrationRun,
  plannedProgressForSourceIds,
} from "../../shared/js-migrate/sourceIdsSupport.mjs";
import { mergeMigrationWithCli } from "../../shared/js-migrate/mergeMigrationConfig.mjs";
import { bindMigrateSrcNumericRange } from "../../shared/js-migrate/migrateCliArgs.mjs";
import {
  applySourceIndexToMigrateJob,
  buildIndexCheckpointSuffix,
  isIndexWindowComplete,
  narrowPlannedRowsForIndex,
  resolvePageSize,
} from "../../shared/js-migrate/sourceIndexRange.mjs";
import { REPAIR_SPEC_APPOINTMENT_RESCHEDULES } from "../../shared/js-migrate/migrateTableSpecs.mjs";
import {
  finalizeRepairFromLog,
  noteRepairBatchNotFoundInSource,
} from "../../shared/js-migrate/repairSummary.mjs";
import {
  batchIds,
  resolveMigrationSourceIds,
} from "../../shared/js-migrate/repairFromLog.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = "appointment_reschedules";

const RESCHEDULE_KEYSET_SENTINEL_SCHEDULE_ID_MIN = -9223372036854775808n;
const RESCHEDULE_KEYSET_SENTINEL_SCHEDULE_ID_MAX = 9223372036854775807n;

function getRescheduleRowField(row, key) {
  return row[key] ?? row[key.toLowerCase()] ?? row[key.toUpperCase()];
}

function rescheduleKeysetMinDate() {
  return new Date(1753, 0, 1, 0, 0, 0, 0);
}

/** จุดเริ่ม keyset DESC: cursor exclusive ด้านบน — แถวแรกคือ LogTime ใหม่สุด */
function rescheduleKeysetMaxDate() {
  return new Date(9999, 11, 31, 23, 59, 59, 997);
}

/**
 * พาร์ส naive datetime เช่น style 126 เป็น Date โซนในเครื่อง (ให้ตรงกับสิ่งที่ driver มักคืนจาก datetime2 naive)
 */
function parseNaiveDatetimeToLocalDate(sRaw) {
  const sTrim = String(sRaw ?? "").trim();
  if (sTrim === "") return null;
  const spaced = sTrim
    .replace(/^(\d{4}-\d{2}-\d{2})\s+/, "$1T")
    .replace(/Z$/i, "");
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?$/.exec(
      spaced,
    );
  if (!m) return null;
  const fracMs = parseFractionalSecsToTruncatedMs(m[7]);
  const dt = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
    fracMs,
  );
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** เศษส่วนวินาทีจาก CONVERT เช่น "1234567" → millis (truncate) */
function parseFractionalSecsToTruncatedMs(frag) {
  if (frag == null || frag === "") return 0;
  const digitsOnly = String(frag).replace(/\D/g, "").slice(0, 7).padEnd(7, "0");
  const secFrac = Number(`0.${digitsOnly}`);
  if (!Number.isFinite(secFrac)) return 0;
  const ms = Math.floor(secFrac * 1000);
  return Math.min(999, ms);
}

/** จับคู่ MSSQL/driver เป็น Date เดียวกับที่ส่งเข้า keyset predicates */
function rescheduleRowDatetimeForKeyset(raw) {
  const min = rescheduleKeysetMinDate();
  if (raw == null) return min;
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? min : raw;
  }
  const parsed = parseNaiveDatetimeToLocalDate(
    String(raw)
      .trim()
      .replace(/^(\d{4}-\d{2}-\d{2})\s+/, "$1T"),
  );
  return parsed ?? min;
}

function defaultRescheduleKeysetAfter() {
  const coalescedMax = rescheduleKeysetMaxDate();
  return {
    logTime: coalescedMax,
    scheduleId: RESCHEDULE_KEYSET_SENTINEL_SCHEDULE_ID_MAX.toString(),
    scheduleDatetime: coalescedMax,
    modifiedDate: coalescedMax,
    oldScheduleDatetime: coalescedMax,
  };
}

function normalizeScheduleIdForKeyset(raw) {
  if (raw == null || String(raw).trim() === "") {
    return RESCHEDULE_KEYSET_SENTINEL_SCHEDULE_ID_MIN.toString();
  }
  try {
    return BigInt(String(raw).trim()).toString();
  } catch {
    return RESCHEDULE_KEYSET_SENTINEL_SCHEDULE_ID_MIN.toString();
  }
}

function normalizeRescheduleKeysetAfter(raw) {
  if (!raw || typeof raw !== "object") return defaultRescheduleKeysetAfter();
  const coalescedMax = rescheduleKeysetMaxDate();
  return {
    logTime: rescheduleRowDatetimeForKeyset(raw.logTime),
    scheduleId: normalizeScheduleIdForKeyset(raw.scheduleId),
    scheduleDatetime: rescheduleRowDatetimeForKeyset(raw.scheduleDatetime),
    modifiedDate: rescheduleRowDatetimeForKeyset(raw.modifiedDate),
    oldScheduleDatetime:
      raw.oldScheduleDatetime == null
        ? coalescedMax
        : rescheduleRowDatetimeForKeyset(raw.oldScheduleDatetime),
  };
}

function keysetAfterFromRescheduleRow(row) {
  const lt = getRescheduleRowField(row, "ktv_log_time_ord");
  const sidOrd = getRescheduleRowField(row, "ktv_schedule_id_ord");
  const sdtOrd = getRescheduleRowField(row, "ktv_schedule_dt_ord");
  const modOrd = getRescheduleRowField(row, "ktv_modified_ord");
  const oldDtOrd = getRescheduleRowField(row, "ktv_old_schedule_dt_ord");
  if (
    lt !== undefined ||
    sidOrd !== undefined ||
    sdtOrd !== undefined ||
    modOrd !== undefined ||
    oldDtOrd !== undefined
  ) {
    return {
      logTime: rescheduleRowDatetimeForKeyset(lt),
      scheduleId: normalizeScheduleIdForKeyset(sidOrd),
      scheduleDatetime: rescheduleRowDatetimeForKeyset(sdtOrd),
      modifiedDate: rescheduleRowDatetimeForKeyset(modOrd),
      oldScheduleDatetime: rescheduleRowDatetimeForKeyset(oldDtOrd),
    };
  }
  const sidRaw = getRescheduleRowField(row, "schedule_id");
  return {
    logTime: rescheduleRowDatetimeForKeyset(
      getRescheduleRowField(row, "log_time"),
    ),
    scheduleId: normalizeScheduleIdForKeyset(sidRaw),
    scheduleDatetime: rescheduleRowDatetimeForKeyset(
      getRescheduleRowField(row, "schedule_datetime"),
    ),
    modifiedDate: rescheduleRowDatetimeForKeyset(
      getRescheduleRowField(row, "modified_date"),
    ),
    oldScheduleDatetime: rescheduleRowDatetimeForKeyset(
      getRescheduleRowField(row, "old_schedule_datetime"),
    ),
  };
}

/** เก็บ checkpoint JSON (ไม่ใช้ ISO ของ Date — ฟอร์แมตเทียบ style 126) */
function formatKeysetDateForCheckpoint(d) {
  const x =
    d instanceof Date && !Number.isNaN(d.getTime())
      ? d
      : rescheduleKeysetMinDate();
  const pad = (n) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}.${String(x.getMilliseconds()).padStart(3, "0")}`;
}

function keysetAfterForPersist(k) {
  const n = normalizeRescheduleKeysetAfter(k);
  return {
    logTime: formatKeysetDateForCheckpoint(n.logTime),
    scheduleDatetime: formatKeysetDateForCheckpoint(n.scheduleDatetime),
    modifiedDate: formatKeysetDateForCheckpoint(n.modifiedDate),
    oldScheduleDatetime: formatKeysetDateForCheckpoint(n.oldScheduleDatetime),
    scheduleId: String(n.scheduleId),
  };
}

/** ส่งเข้า keyset MSSQL — เป็น Date object (ไม่ string จาก String(Date) เพื่อไม่เพี้ยน) */
function bindRescheduleKeysetInputs(req, keysetAfter) {
  const k = normalizeRescheduleKeysetAfter(keysetAfter);
  req.input("afterLogTime", sql.DateTime2, k.logTime);
  req.input("afterScheduleId", sql.BigInt, BigInt(String(k.scheduleId).trim()));
  req.input("afterScheduleDatetime", sql.DateTime2, k.scheduleDatetime);
  req.input("afterModifiedDate", sql.DateTime2, k.modifiedDate);
  req.input("afterOldScheduleDatetime", sql.DateTime2, k.oldScheduleDatetime);
}

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
      options: { ...base.options, ...timeouts },
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
    if (selectedProfile === "appointment_reschedules") {
      process.stdout.write(
        ">>> คำเตือน: ไม่พบ profiles.appointment_reschedules ใน config — ใช้ shared อย่างเดียว (แนะนำคัดลอก profile จาก migration.config.example.json ไปใส่ migration.config.local.json)\n",
      );
      profileConfig = {};
    } else {
      throw new Error(
        `Profile '${selectedProfile}' not found in config.profiles — ตรวจสอบ --profile`,
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
      "MSSQL: กำหนด source.password ใน migration.config.local.json",
    );
  }
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

function getLogKeyForChunkLog(row) {
  return rescheduleLogKey(row) ?? "";
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

/** @param {string} logKey */
function parseLogKey(logKey) {
  const parts = String(logKey).split("|");
  if (parts.length < 2) return null;
  return {
    scheduleId: parts[0] === "" ? null : parts[0],
    logTime: parts[1],
    scheduleDatetime: parts[2] ?? null,
  };
}

async function fetchMssqlRowsByLogKeys(mssqlPool, sourceObject, logKeys) {
  const parsed = logKeys.map(parseLogKey).filter((p) => p?.logTime);
  if (parsed.length === 0) return [];

  const req = mssqlPool.request();
  const preds = [];
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    const ltParam = `lt${i}`;
    req.input(ltParam, sql.DateTime2, new Date(p.logTime.replace("T", " ")));
    if (p.scheduleId == null) {
      preds.push(`([LogTime] = @${ltParam} AND [Schedule_ID] IS NULL)`);
    } else {
      const sidParam = `sid${i}`;
      req.input(sidParam, sql.Int, Number.parseInt(p.scheduleId, 10));
      preds.push(`([LogTime] = @${ltParam} AND [Schedule_ID] = @${sidParam})`);
    }
  }

  const sqlText = MSSQL_APPOINTMENT_RESCHEDULES_BY_LOG_KEYS_SELECT.replaceAll(
    "{{sourceObject}}",
    sourceObject,
  ).replace("{{logKeyPredicates}}", preds.join(" OR "));

  const r = await req.query(sqlText);
  return r.recordset || [];
}

/** คืน connection ที่ยืมจาก tarn pool ภายใน ConnectionPool ของ mssql (field `pool`) */
function releaseBorrowedMssqlPoolConnection(mssqlPool, conn) {
  if (conn != null && mssqlPool.pool != null) {
    try {
      mssqlPool.pool.release(conn);
    } catch {
      /* ignore */
    }
  }
}

/**
 * สร้าง parent แบบจำลองสำหรับ `new sql.Request(parent)` ให้ทุก query ใช้ connection เดียว
 * (เลี่ยง `sql.Transaction` + ISOLATION_SNAPSHOT ผ่าน tedious ที่อาจได้ ENOTBEGUN หลัง rollback token)
 */
function createMssqlSingleConnectionRequestParent(mssqlPool, conn) {
  return {
    config: mssqlPool.config,
    collation: mssqlPool.collation,
    /** mssql Request ตรวจ parent.connected ก่อน query — ถ้าไม่มีจะได้ «Connection is closed» เสมอ */
    get connected() {
      return Boolean(
        mssqlPool.connected && conn != null && conn.closed !== true,
      );
    },
    acquire(_request, callback) {
      setImmediate(callback, null, conn, mssqlPool.config);
    },
    release() {
      /* connection คืนด้วย releaseBorrowedMssqlPoolConnection เมื่อจบงาน */
    },
  };
}

async function runAppointmentReschedulesTableJob({
  mssqlPool,
  pgClient,
  migrationConfig = {},
  source,
}) {
  const key = KEY;
  const batchSize = Math.max(
    50,
    Math.min(20000, Number(migrationConfig.batchSize ?? 8000)),
  );
  const checkpointEnabled = migrationConfig.enableCheckpoint !== false;
  const checkpointDir = path.resolve(
    __dirname,
    migrationConfig.checkpointDir ?? "./checkpoints",
  );
  fs.mkdirSync(checkpointDir, { recursive: true });
  const indexCkSuffix = buildIndexCheckpointSuffix(migrationConfig);
  const checkpointPath = path.join(
    checkpointDir,
    `${key}${indexCkSuffix}.json`,
  );
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
  const sourceTable = source?.table ?? "SCHEDULE_LOG";
  const sourceObject = `${bracketIdent(sourceSchema)}.${bracketIdent(sourceTable)}`;
  const sourceObjectNoLock = `${sourceObject} WITH (NOLOCK)`;

  const useMssqlKeysetBase =
    migrationConfig.useMssqlKeyset === undefined ||
    migrationConfig.useMssqlKeyset === true;
  let useMssqlKeyset = useMssqlKeysetBase;
  const resumeWithLegacyOffsetCheckpoint =
    useMssqlKeyset && offset > 0 && checkpoint.mssqlKeysetAfter == null;
  if (resumeWithLegacyOffsetCheckpoint) {
    useMssqlKeyset = false;
  }

  let mssqlKeysetAfter =
    checkpoint.mssqlKeysetAfter == null ? null : checkpoint.mssqlKeysetAfter;
  if (!useMssqlKeyset) {
    mssqlKeysetAfter = null;
  } else if (mssqlKeysetAfter == null) {
    mssqlKeysetAfter = defaultRescheduleKeysetAfter();
  } else {
    mssqlKeysetAfter = normalizeRescheduleKeysetAfter(mssqlKeysetAfter);
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

  const logsDir = path.resolve(__dirname, "logs");
  const repairSourceIds = resolveMigrationSourceIds(
    migrationConfig,
    logsDir,
    REPAIR_SPEC_APPOINTMENT_RESCHEDULES,
  );
  const repairBatches =
    repairSourceIds != null ? [...batchIds(repairSourceIds, batchSize)] : null;
  let repairBatchIndex = 0;
  const repairNotFoundInSource = repairSourceIds != null ? new Set() : null;

  const chunkLogMode = String(
    migrationConfig.chunkLogMode ?? "compact",
  ).toLowerCase();
  const chunkSampleEvery = Math.max(
    1,
    Number(migrationConfig.chunkSampleEvery ?? 50),
  );
  const sourceLimitRaw = migrationConfig.sourceLimit;
  const sourceLimit =
    sourceLimitRaw == null ? null : Math.max(1, Number(sourceLimitRaw));
  const probeTiming = migrationConfig.probeTiming === true;
  const progressEnabled = migrationConfig.progressUi !== false;
  const progressStartedAt = Date.now();
  const debugLogs = migrationConfig.debugLogs === true || probeTiming;
  const uiState = createUiState();

  if (resumeWithLegacyOffsetCheckpoint) {
    writeOutLine(
      `>>> [${key}] resume: ใช้ OFFSET (checkpoint เก่า) — ลบ checkpoint แล้วรันใหม่จะกลับไป keyset`,
      uiState,
    );
  }

  if (
    useMssqlKeyset &&
    checkpoint.mssqlKeysetAfter != null &&
    checkpoint.mssqlKeysetAfter.oldScheduleDatetime == null
  ) {
    writeOutLine(
      `>>> [${key}] คำเตือน: checkpoint เก่า (keyset 4 มิติ) ไม่เข้ากับสคริปต์ปัจจุบัน — ลบ checkpoints/ แล้ว TRUNCATE ปลายทาง รัน overwrite`,
      uiState,
    );
  }

  if (repairSourceIds != null && repairSourceIds.length === 0) {
    writeOutLine(`>>> [${key}] repair-from-log: ไม่มี id ให้ migrate`, uiState);
    return {
      key,
      totalRowsRead: 0,
      fieldIssueLogPath: null,
      checkpointPath: checkpointEnabled ? checkpointPath : null,
      chunkCount: 0,
      successChunkCount: 0,
      failedChunkCount: 0,
      chunkResults: [],
    };
  }
  if (repairSourceIds != null) {
    logByIdMigrationRun(
      key,
      repairSourceIds.length,
      "log_key",
      migrationConfig,
    );
  }

  await ensureAppointmentReschedulesPipelineDdl(pgClient);
  await resetAppointmentReschedulesIdSequenceIfEmpty(pgClient);
  await warmupAppointmentReschedulesLookups(pgClient);

  /**
   * SNAPSHOT: ยืม connection เดียวจาก pool แล้วรัน T-SQL `SET TRANSACTION ISOLATION LEVEL SNAPSHOT` + `BEGIN TRAN`
   * (ไม่ใช้ `sql.Transaction` + isolation ของ driver — บางเซิร์ฟเวอร์/เวอร์ชันชนกับ `rollbackTransaction` → ENOTBEGUN)
   */
  let mssqlSnapshotDedicatedParent = null;
  let mssqlSnapshotConn = null;
  /** @type {() => import('mssql').Request} */
  let mssqlRequest = () => mssqlPool.request();
  const useMssqlNolock = migrationConfig.mssqlUseNolock === true;
  let sourceRef = useMssqlNolock ? sourceObjectNoLock : sourceObject;
  let mssqlSnapshotIsolationActive = false;

  if (
    repairSourceIds == null &&
    migrationConfig.mssqlSnapshotIsolation !== false
  ) {
    try {
      if (mssqlPool.pool == null) {
        throw new Error("MSSQL pool not ready (missing internal pool)");
      }
      mssqlSnapshotConn = await mssqlPool.pool.acquire().promise;
      mssqlSnapshotDedicatedParent = createMssqlSingleConnectionRequestParent(
        mssqlPool,
        mssqlSnapshotConn,
      );
      mssqlRequest = () => new sql.Request(mssqlSnapshotDedicatedParent);
      await new sql.Request(mssqlSnapshotDedicatedParent).query(
        `SET TRANSACTION ISOLATION LEVEL SNAPSHOT;\nBEGIN TRANSACTION;`,
      );
      sourceRef = sourceObject;
      mssqlSnapshotIsolationActive = true;
      writeOutLine(
        `>>> [${key}] MSSQL SNAPSHOT: connection เดียว + T-SQL isolation (COUNT + fetch สแนปช็อตเดียวกัน)`,
        uiState,
      );
    } catch (snapErr) {
      releaseBorrowedMssqlPoolConnection(mssqlPool, mssqlSnapshotConn);
      mssqlSnapshotConn = null;
      mssqlSnapshotDedicatedParent = null;
      mssqlRequest = () => mssqlPool.request();
      sourceRef = useMssqlNolock ? sourceObjectNoLock : sourceObject;
      writeOutLine(
        `>>> [${key}] คำเตือน: SNAPSHOT ไม่พร้อม (${snapErr instanceof Error ? snapErr.message : String(snapErr)}) — เปิด ALLOW_SNAPSHOT_ISOLATION ในฐาน MSSQL หรือตั้ง mssqlSnapshotIsolation:false และยอมเหลื่อมจำนวนได้`,
        uiState,
      );
    }
  }

  const offsetSelectSql = MSSQL_APPOINTMENT_RESCHEDULES_SELECT.replaceAll(
    "{{sourceObject}}",
    sourceRef,
  ).replaceAll("{{orderBy}}", MSSQL_APPOINTMENT_RESCHEDULES_OFFSET_ORDER_BY);
  const keysetSelectSql =
    buildMssqlAppointmentReschedulesKeysetSelect().replaceAll(
      "{{sourceObject}}",
      sourceRef,
    );

  let plannedRows = sourceLimit;
  if (plannedRows == null && progressEnabled) {
    try {
      const countRes = await mssqlRequest().query(`
        SELECT COUNT_BIG(1) AS total
        FROM ${sourceRef}
        WHERE [Activity] = N'ย้ายวันนัด'
      `);
      plannedRows = Number(countRes.recordset?.[0]?.total ?? 0);
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
  let progressTotal = plannedRows ?? null;
  let plannedChunks =
    plannedRows != null && plannedRows > 0
      ? Math.ceil(plannedRows / batchSize)
      : null;
  if (repairSourceIds != null) {
    const idPlan = plannedProgressForSourceIds(repairSourceIds, batchSize);
    if (idPlan) {
      plannedRows = idPlan.plannedRows;
      plannedChunks = idPlan.plannedChunks;
      progressTotal = idPlan.plannedRows;
    }
  }
  if (sourceLimit != null) {
    writeOutLine(
      `>>> [${key}] TEMP sourceLimit enabled: ${sourceLimit} records`,
      uiState,
    );
  }
  if (plannedChunks != null) {
    writeOutLine(
      `>>> [${key}] plan: ${plannedRows} rows, ~${plannedChunks} chunks`,
      uiState,
    );
  }
  if (probeTiming) {
    writeOutLine(
      `>>> [${key}] probeTiming enabled (MSSQL query latency logs)`,
      uiState,
    );
  }

  writeOutLine(
    `>>> [${key}] start offset: ${offset}${
      useMssqlKeyset
        ? " (MSSQL keyset DESC: LogTime→Schedule_ID→Schedule_Datetime→ModifiedDate→Old_Schedule_Datetime · Activity=ย้ายวันนัด)"
        : " (MSSQL OFFSET DESC · Activity=ย้ายวันนัด)"
    }`,
    uiState,
  );
  writeOutLine(
    `>>> [${key}] insert ทุกแถวจาก MSSQL (ไม่ dedupe / ไม่ข้ามคีย์ซ้ำใน Postgres)`,
    uiState,
  );

  let total = 0;
  let totalRowsWritten = 0;
  const fieldIssueAcc = createFieldIssueAccumulator("log_key");
  const fieldIssueLogPath = path.join(
    logsDir,
    `migration-field-issues-appointment_reschedules-${nowStamp()}.json`,
  );
  fs.mkdirSync(path.dirname(fieldIssueLogPath), { recursive: true });
  const chunkResults = [];
  let chunkIndex = 0;
  let successChunkCount = 0;
  let failedChunkCount = 0;

  try {
    while (true) {
      const chunkT0 = Date.now();
      const pageSize = resolvePageSize({
        batchSize,
        total,
        sourceLimit,
        plannedRows: idx.indexLimited ? plannedRows : null,
      });
      if (pageSize <= 0) break;
      const nextChunkIndex = chunkIndex + 1;
      if (debugLogs) {
        writeOutLine(
          `>>> [${key}] fetch chunk ${nextChunkIndex}: ${
            useMssqlKeyset && !repairBatches
              ? `keyset after ${JSON.stringify(keysetAfterForPersist(mssqlKeysetAfter ?? defaultRescheduleKeysetAfter()))}`
              : `offset=${offset}`
          } pageSize=${pageSize}`,
          uiState,
        );
      }

      let rows = [];
      let fetchElapsedMs = 0;
      if (repairBatches) {
        if (repairBatchIndex >= repairBatches.length) break;
        const idBatch = repairBatches[repairBatchIndex++];
        const fetchStartedAt = Date.now();
        rows = await fetchMssqlRowsByLogKeys(mssqlPool, sourceObject, idBatch);
        fetchElapsedMs = Date.now() - fetchStartedAt;
        if (repairNotFoundInSource) {
          noteRepairBatchNotFoundInSource(
            repairNotFoundInSource,
            idBatch,
            rows,
            (r) => getLogKeyForChunkLog(r),
          );
        }
        if (rows.length === 0) continue;
      } else {
        const fetchStartedAt = Date.now();
        const rq = mssqlRequest();
        bindMigrateSrcNumericRange(rq, migrationConfig, sql);
        let r;
        if (useMssqlKeyset) {
          bindRescheduleKeysetInputs(rq, mssqlKeysetAfter);
          r = await rq.input("page", sql.Int, pageSize).query(keysetSelectSql);
        } else {
          r = await rq
            .input("offset", sql.Int, offset)
            .input("page", sql.Int, pageSize)
            .query(offsetSelectSql);
        }
        fetchElapsedMs = Date.now() - fetchStartedAt;
        if (debugLogs) {
          writeOutLine(
            `>>> [${key}] fetched rows: ${(r.recordset || []).length} (chunk ${nextChunkIndex}, mssql_query_ms=${fetchElapsedMs})`,
            uiState,
          );
        }
        rows = r.recordset || [];
      }

      if (rows.length === 0) {
        if (debugLogs) {
          writeOutLine(
            `>>> [${key}] no more rows (mssql ${fetchElapsedMs}ms); chunk wall ${Date.now() - chunkT0}ms`,
            uiState,
          );
        }
        break;
      }

      const n = rows.length;
      chunkIndex += 1;
      const sourceOffsetStart = offset;
      const sourceOffsetEnd = offset + n - 1;
      const firstKey = getLogKeyForChunkLog(rows[0]);
      const lastKey = getLogKeyForChunkLog(rows[n - 1]);

      let step = "begin chunk transaction";
      let lastChunkProcessMs = 0;
      try {
        await pgClient.query("BEGIN");
        step = "run appointment_reschedules post-load";
        const postLoadResult = await runAppointmentReschedulesChunkPostLoad(
          pgClient,
          rows,
          { migrateRowMode: migrationConfig.migrateRowMode },
        );
        mergeFieldIssueChunk(fieldIssueAcc, postLoadResult);
        totalRowsWritten += postLoadResult.rowsWritten ?? 0;
        await pgClient.query("COMMIT");
        lastChunkProcessMs = Date.now() - chunkT0;
        successChunkCount += 1;
        const chunkResult = {
          chunkIndex,
          status: "success",
          sourceOffsetStart,
          sourceOffsetEnd,
          rowCount: n,
          firstKey,
          lastKey,
          rowsWritten: postLoadResult.rowsWritten,
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
        const chunkTotalMs = Date.now() - chunkT0;
        writeOutLine(
          `>>> [${key}] chunk ${chunkIndex} failed after ${chunkTotalMs}ms (mssql_fetch ${fetchElapsedMs}ms) at step: ${step}`,
          uiState,
        );
        chunkResults.push({
          chunkIndex,
          status: "failed",
          sourceOffsetStart,
          sourceOffsetEnd,
          rowCount: n,
          firstKey,
          lastKey,
          mssqlFetchMs: fetchElapsedMs,
          chunkTotalMs,
          failedAtStep: step,
          error: err instanceof Error ? err.message : String(err),
        });
        throw new Error(
          `[${key}] failed chunk ${chunkIndex} (offset ${sourceOffsetStart}-${sourceOffsetEnd}, ${firstKey}..${lastKey}) at step '${step}': ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      total += n;
      if (!repairBatches) {
        offset += n;
        if (useMssqlKeyset) {
          mssqlKeysetAfter = keysetAfterFromRescheduleRow(rows[n - 1]);
        }
      }
      if (checkpointEnabled && !repairBatches) {
        writeJson(checkpointPath, {
          key,
          offset,
          mssqlKeysetAfter:
            useMssqlKeyset && mssqlKeysetAfter
              ? keysetAfterForPersist(mssqlKeysetAfter)
              : null,
          completed: false,
          updatedAt: new Date().toISOString(),
        });
      }
      const isLastPage =
        isIndexWindowComplete({
          indexLimited: idx.indexLimited,
          plannedRows,
          rowsReadInWindow: total,
        }) ||
        (useMssqlKeyset ? isLastKeysetPage(n, pageSize) : n < pageSize);
      if (debugLogs) {
        writeOutLine(
          `>>> [${key}] chunk ${chunkIndex}/${plannedChunks ?? "?"} done ${formatSec(
            lastChunkProcessMs,
          )} (fetch ${formatSec(fetchElapsedMs)}) rows ${n}, total ${total}/${plannedRows ?? "?"}`,
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
      rows.length = 0;
      if (isLastPage) break;
      if (plannedRows != null && total >= plannedRows && n >= pageSize) {
        writeOutLine(
          `>>> [${key}] คำเตือน: อ่านครบตาม COUNT (${plannedRows}) แต่ MSSQL ยังส่งแถวเต็มหน้า — หยุดเพื่อกันวน keyset (ลบ checkpoint แล้วรันใหม่หลังอัปเดตสคริปต์)`,
          uiState,
        );
        break;
      }
    }
  } catch (loopErr) {
    if (mssqlSnapshotConn != null && mssqlSnapshotDedicatedParent != null) {
      try {
        await new sql.Request(mssqlSnapshotDedicatedParent).query(
          "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;",
        );
      } catch {
        /* ignore */
      }
      releaseBorrowedMssqlPoolConnection(mssqlPool, mssqlSnapshotConn);
      mssqlSnapshotConn = null;
      mssqlSnapshotDedicatedParent = null;
    }
    throw loopErr;
  }

  if (mssqlSnapshotConn != null && mssqlSnapshotDedicatedParent != null) {
    try {
      await new sql.Request(mssqlSnapshotDedicatedParent).query(
        "COMMIT TRANSACTION;",
      );
    } catch (commitErr) {
      writeOutLine(
        `>>> [${key}] คำเตือน: COMMIT MSSQL SNAPSHOT ล้มเหลว (${commitErr instanceof Error ? commitErr.message : String(commitErr)})`,
        uiState,
      );
    }
    releaseBorrowedMssqlPoolConnection(mssqlPool, mssqlSnapshotConn);
    mssqlSnapshotConn = null;
    mssqlSnapshotDedicatedParent = null;
  }

  if (progressEnabled) endProgress(uiState);

  if (
    plannedRows != null &&
    plannedRows > 0 &&
    total > plannedRows &&
    !mssqlSnapshotIsolationActive
  ) {
    writeOutLine(
      `>>> [${key}] คำเตือน: อ่าน MSSQL ${total}/${plannedRows} (เกิน ${total - plannedRows}) — เมื่อไม่มี SNAPSHOT: COUNT เป็น «จุดเดียวในวินาทีนั้น» แต่การดึง keyset ใช้หลายนาที ถ้ามีแถวใหม่ที่ Activity=ย้ายวันนัด ถูก commit ระหว่างรัน จำนวนที่อ่านได้จะมากกว่า COUNT แรกได้ปกติ (ไม่ได้แปลว่า Directus เพิ่มแถวเอง) • แก้ให้ SNAPSHOT เริ่มสำเร็จ (ดู log บนสุด) เพื่อให้ COUNT กับ fetch ใช้สแนปช็อตเดียวกัน หรือหยุดเขียน MSSQL ระหว่าง migrate`,
      uiState,
    );
  }

  if (plannedRows != null && plannedRows > 0 && total < plannedRows) {
    if (
      mssqlSnapshotIsolationActive &&
      sourceLimit == null &&
      repairBatches == null
    ) {
      writeOutLine(
        `>>> [${key}] คำเตือน: ภายใต้ SNAPSHOT อ่าน MSSQL ${total}/${plannedRows} (ขาด ${plannedRows - total}) — ไม่น่าเกิดขึ้น ควรตรวจ keyset / เงื่อนไข Activity; ลองลบ checkpoints/ truncate แล้วรัน overwrite หรือแจ้งทีม`,
        uiState,
      );
    } else {
      writeOutLine(
        `>>> [${key}] คำเตือน: อ่าน MSSQL ${total}/${plannedRows} (ขาด ${plannedRows - total}) — ลบ checkpoints/ แล้ว TRUNCATE ตาราง รัน overwrite ทับชุดเดิมอีกครั้ง`,
        uiState,
      );
    }
  }

  if (
    mssqlSnapshotIsolationActive &&
    sourceLimit == null &&
    repairBatches == null &&
    plannedRows != null &&
    plannedRows > 0 &&
    total > plannedRows
  ) {
    writeOutLine(
      `>>> [${key}] คำเตือน: ภายใต้ SNAPSHOT อ่านได้ ${total} แถว แต่ COUNT ได้ ${plannedRows} — ไม่น่าเกิดขึ้น ควรตรวจเงื่อนไข keyset / Activity หรือแจ้งทีม`,
      uiState,
    );
  }

  if (checkpointEnabled) {
    writeJson(checkpointPath, {
      key,
      offset,
      mssqlKeysetAfter:
        useMssqlKeyset && mssqlKeysetAfter
          ? keysetAfterForPersist(mssqlKeysetAfter)
          : null,
      completed: true,
      updatedAt: new Date().toISOString(),
    });
  }

  await syncAppointmentReschedulesIdSequence(pgClient);
  await ensureAppointmentReschedulesTargetIndexes(pgClient);

  let fieldIssueLogWritten = null;
  if (fieldIssueAcc.totalFieldIssueCount > 0) {
    const payload = buildFieldIssueLogPayload(fieldIssueAcc, {
      migrationKey: key,
      logType: "appointment_reschedules_field_issues",
      recordIdKey: "log_key",
      buildRecord: (rec) => ({
        log_key: String(rec.log_key),
        schedule_id: rec.schedule_id ?? null,
        log_time: rec.log_time ?? null,
        fieldIssues: rec.fieldIssues ?? [],
      }),
    });
    writeFieldIssueLogFile(fieldIssueLogPath, payload);
    fieldIssueLogWritten = fieldIssueLogPath;
  }

  const repairSummary =
    repairSourceIds != null
      ? finalizeRepairFromLog(
          key,
          REPAIR_SPEC_APPOINTMENT_RESCHEDULES,
          repairSourceIds,
          {
            notFoundInSourceIds: repairNotFoundInSource,
            fieldIssueAcc,
          },
        )
      : null;

  const summary = {
    key,
    totalRowsRead: total,
    totalRowsWritten,
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
  writeOutLine(
    `>>> [${key}] done, MSSQL read: ${total}, Postgres inserted: ${totalRowsWritten}`,
    uiState,
  );
  return summary;
}

async function main() {
  const configPath = path.resolve(process.cwd(), getConfigPath());
  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const config = resolveRuntimeConfig(rawConfig, "appointment_reschedules");
  const migrationForJob = mergeMigrationWithCli(
    config?.migration,
    "appointment_reschedules",
  );

  /** Chunk ขั้นต่ำของงานนี้ (แยกจาก shared.batchSize=2000); ยกเลิกได้โดยตั้ง profiles.appointment_reschedules.migration.batchSize */
  const APPT_RS_BATCH_FLOOR = 8000;
  const APPT_RS_BATCH_CAP = 20000;
  const profMig = rawConfig.profiles?.appointment_reschedules?.migration;
  const profileBatchExplicit =
    profMig != null &&
    Object.prototype.hasOwnProperty.call(profMig, "batchSize") &&
    profMig.batchSize != null &&
    String(profMig.batchSize).trim() !== "";
  const sharedBatch = config?.migration?.batchSize;
  if (profileBatchExplicit) {
    const v = Number(profMig.batchSize);
    migrationForJob.batchSize = Number.isFinite(v)
      ? Math.max(50, Math.min(APPT_RS_BATCH_CAP, v))
      : APPT_RS_BATCH_FLOOR;
  } else {
    const cur = Number(migrationForJob.batchSize);
    const next = Number.isFinite(cur)
      ? Math.min(APPT_RS_BATCH_CAP, Math.max(APPT_RS_BATCH_FLOOR, cur))
      : APPT_RS_BATCH_FLOOR;
    migrationForJob.batchSize = next;
    if (
      sharedBatch != null &&
      Number(sharedBatch) !== next &&
      Number.isFinite(Number(sharedBatch))
    ) {
      process.stdout.write(
        `>>> [appointment_reschedules] batchSize: ${sharedBatch} → ${next} (ขั้นต่ำของงานนี้ ${APPT_RS_BATCH_FLOOR}; ตั้ง profiles.appointment_reschedules.migration.batchSize เพื่อบังคับเอง)\n`,
      );
    }
  }

  if (!config?.source) throw new Error("Missing source config");
  if (!config?.target) throw new Error("Missing target config");
  if (config.__profileName) {
    process.stdout.write(`>>> using config profile: ${config.__profileName}\n`);
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
      const result = await runAppointmentReschedulesTableJob({
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
    process.stdout.write(`>>> migration log saved: ${logPath}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
