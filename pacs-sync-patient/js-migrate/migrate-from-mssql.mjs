/**
 * migrate dbo.PACS_SYNC_PATIENT (MSSQL) -> public.pacs_sync_patient (Postgres/Directus)
 *
 * ต้นทางเป็นตาราง log ไม่มี PK — เรียง UpdateTime เก่า→ใหม่ แล้วเดินด้วย keyset
 * (UpdateTime, PID, %%physloc%%) เหมือน appointment_reschedules; insert ทุกแถว ไม่ dedupe
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import pg from "pg";
import {
  MSSQL_PACS_SYNC_PATIENT_BY_LOG_KEYS_SELECT,
  MSSQL_PACS_SYNC_PATIENT_KEYSET_AFTER_PREDICATE,
  MSSQL_PACS_SYNC_PATIENT_ORDER_BY,
  MSSQL_PACS_SYNC_PATIENT_SELECT,
  MSSQL_PSP_KEYSET_TEXT_LEN,
  buildMssqlPacsSyncPatientKeysetSelect,
  buildPacsSyncPatientLogKeyPredicate,
} from "./mssqlPacsSyncPatientSelect.mjs";
import {
  ensurePacsSyncPatientPipelineDdl,
  ensurePacsSyncPatientTargetIndexes,
} from "./pacsSyncPatientPgDdl.mjs";
import {
  pacsSyncPatientLogKey,
  resetPacsSyncPatientIdSequenceIfEmpty,
  resetPacsSyncPatientTargetColumnCache,
  runPacsSyncPatientChunkPostLoad,
  syncPacsSyncPatientIdSequence,
} from "./pacsSyncPatientMapping.mjs";
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
import { logByIdMigrationRun } from "../../shared/js-migrate/sourceIdsSupport.mjs";
import { mergeMigrationWithCli } from "../../shared/js-migrate/mergeMigrationConfig.mjs";
import {
  bracketMssqlIdent,
  buildMssqlConfig,
} from "../../shared/js-migrate/mssqlConnectConfig.mjs";
import {
  applySourceIndexToMigrateJob,
  buildIndexCheckpointSuffix,
  plannedRowsForPageSize,
  resolvePageSize,
  shouldStopMigratePagination,
  trimRowsToMigrateCap,
} from "../../shared/js-migrate/sourceIndexRange.mjs";
import { prepareMigrateRowPlan } from "../../shared/js-migrate/sourceCountSnapshot.mjs";
import { reconcileResumeOffsetByAfterCount } from "../../shared/js-migrate/createdDateKeysetFetch.mjs";
import { REPAIR_SPEC_PACS_SYNC_PATIENT } from "../../shared/js-migrate/migrateTableSpecs.mjs";
import {
  finalizeRepairFromLog,
  noteRepairBatchNotFoundInSource,
} from "../../shared/js-migrate/repairSummary.mjs";
import {
  batchIds,
  resolveMigrationSourceIds,
} from "../../shared/js-migrate/repairFromLog.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = "pacs_sync_patient";

/** ความยาวที่ ORDER BY ตัด — param ต้องตัดเท่ากันไม่งั้นเทียบคนละค่า */
const KEYSET_TEXT_LEN = MSSQL_PSP_KEYSET_TEXT_LEN;

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

function resolveRuntimeConfig(rawConfig, fallbackProfile) {
  if (!rawConfig?.profiles) return rawConfig;

  const selectedProfile =
    getProfileName() ?? rawConfig.defaultProfile ?? fallbackProfile;
  let profileConfig = rawConfig.profiles[selectedProfile];
  if (profileConfig === undefined) {
    if (selectedProfile === KEY) {
      process.stdout.write(
        `>>> คำเตือน: ไม่พบ profiles.${KEY} ใน config — ใช้ shared อย่างเดียว\n`,
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

function getRowField(row, key) {
  return row[key] ?? row[key.toLowerCase()] ?? row[key.toUpperCase()];
}

/** %%physloc%% floor = 8 ไบต์ศูนย์ (physloc จริง file:page:slot ไม่มีทางเป็นศูนย์ทั้งหมด → `> floor` ครอบทุกแถว) */
function physlocFloor() {
  return Buffer.alloc(8);
}

/** Buffer(8) จาก physloc ที่อาจเป็น Buffer (driver) หรือ hex string (checkpoint) */
function normalizePhysloc(raw) {
  if (raw == null) return physlocFloor();
  if (Buffer.isBuffer(raw)) {
    if (raw.length === 8) return raw;
    const b = Buffer.alloc(8);
    raw.copy(b, 0, 0, Math.min(8, raw.length));
    return b;
  }
  const s = String(raw)
    .trim()
    .replace(/^0x/i, "");
  if (/^[0-9a-fA-F]{1,16}$/.test(s)) {
    return Buffer.from(s.padStart(16, "0").slice(-16), "hex");
  }
  return physlocFloor();
}

function normalizeKeysetText(raw) {
  if (raw == null) return "";
  return String(raw).slice(0, KEYSET_TEXT_LEN);
}

/** จุดเริ่ม keyset ASC — ค่าว่างต่ำกว่าทุกแถว (COALESCE ในคิวรีใช้ N'' เหมือนกัน) */
function defaultKeysetAfter() {
  return { updateTime: "", pid: "", physloc: physlocFloor() };
}

function normalizeKeysetAfter(raw) {
  if (!raw || typeof raw !== "object") return defaultKeysetAfter();
  return {
    updateTime: normalizeKeysetText(raw.updateTime),
    pid: normalizeKeysetText(raw.pid),
    physloc: normalizePhysloc(raw.physloc ?? raw.physlocHex),
  };
}

function keysetAfterFromRow(row) {
  const utOrd = getRowField(row, "ktv_update_time_ord");
  const pidOrd = getRowField(row, "ktv_pid_ord");
  const physlocRaw = getRowField(row, "ktv_physloc");
  if (utOrd !== undefined || pidOrd !== undefined) {
    return {
      updateTime: normalizeKeysetText(utOrd),
      pid: normalizeKeysetText(pidOrd),
      physloc: normalizePhysloc(physlocRaw),
    };
  }
  return {
    updateTime: normalizeKeysetText(getRowField(row, "update_time")),
    pid: normalizeKeysetText(getRowField(row, "old_pid")),
    physloc: normalizePhysloc(physlocRaw),
  };
}

function keysetAfterForPersist(k) {
  const n = normalizeKeysetAfter(k);
  return {
    updateTime: n.updateTime,
    pid: n.pid,
    physlocHex: n.physloc.toString("hex"),
  };
}

function bindKeysetInputs(req, keysetAfter) {
  const k = normalizeKeysetAfter(keysetAfter);
  req.input("afterUpdateTime", sql.NVarChar(KEYSET_TEXT_LEN), k.updateTime);
  req.input("afterPid", sql.NVarChar(KEYSET_TEXT_LEN), k.pid);
  req.input("afterPhysloc", sql.Binary(8), normalizePhysloc(k.physloc));
}

function getLogKeyForChunkLog(row) {
  return pacsSyncPatientLogKey(row) ?? "";
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

/** @param {string} logKey รูป "<UpdateTime>|<PID>" */
function parseLogKey(logKey) {
  const parts = String(logKey).split("|");
  if (parts.length < 2) return null;
  const updateTime = parts[0];
  const pid = parts.slice(1).join("|");
  if (updateTime === "" && pid === "") return null;
  return { updateTime, pid };
}

async function fetchMssqlRowsByLogKeys(mssqlPool, sourceObject, logKeys) {
  const parsed = logKeys.map(parseLogKey).filter(Boolean);
  if (parsed.length === 0) return [];

  const req = mssqlPool.request();
  const preds = [];
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    req.input(
      `ut${i}`,
      sql.NVarChar(KEYSET_TEXT_LEN),
      normalizeKeysetText(p.updateTime),
    );
    req.input(
      `pid${i}`,
      sql.NVarChar(KEYSET_TEXT_LEN),
      normalizeKeysetText(p.pid),
    );
    preds.push(buildPacsSyncPatientLogKeyPredicate(i));
  }

  const sqlText = MSSQL_PACS_SYNC_PATIENT_BY_LOG_KEYS_SELECT.replaceAll(
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
 * parent จำลองสำหรับ `new sql.Request(parent)` ให้ทุก query ใช้ connection เดียว
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

async function runPacsSyncPatientTableJob({
  mssqlPool,
  pgClient,
  migrationConfig = {},
  source,
}) {
  const key = KEY;
  const batchSize = Math.max(
    50,
    Math.min(20000, Number(migrationConfig.batchSize ?? 2000)),
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
  const sourceTable = source?.table ?? "PACS_SYNC_PATIENT";
  const sourceObject = `${bracketMssqlIdent(sourceSchema)}.${bracketMssqlIdent(sourceTable)}`;
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
    mssqlKeysetAfter = defaultKeysetAfter();
  } else {
    mssqlKeysetAfter = normalizeKeysetAfter(mssqlKeysetAfter);
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
  fs.mkdirSync(logsDir, { recursive: true });
  const repairSourceIds = resolveMigrationSourceIds(
    migrationConfig,
    logsDir,
    REPAIR_SPEC_PACS_SYNC_PATIENT,
  );
  const repairBatches =
    repairSourceIds != null ? [...batchIds(repairSourceIds, batchSize)] : null;
  let repairBatchIndex = 0;
  const repairNotFoundInSource = repairSourceIds != null ? new Set() : null;

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
  const progressStartedAt = Date.now();
  const debugLogs = migrationConfig.debugLogs === true;
  const uiState = createUiState();

  if (resumeWithLegacyOffsetCheckpoint) {
    writeOutLine(
      `>>> [${key}] resume: ใช้ OFFSET (checkpoint เก่า) — ลบ checkpoint แล้วรันใหม่จะกลับไป keyset`,
      uiState,
    );
  }

  if (repairSourceIds != null && repairSourceIds.length === 0) {
    writeOutLine(`>>> [${key}] repair-from-log: ไม่มี id ให้ migrate`, uiState);
    return {
      key,
      totalRowsRead: 0,
      totalRowsWritten: 0,
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

  resetPacsSyncPatientTargetColumnCache();
  await ensurePacsSyncPatientPipelineDdl(pgClient);
  await resetPacsSyncPatientIdSequenceIfEmpty(pgClient);

  /**
   * SNAPSHOT: ยืม connection เดียวจาก pool แล้วรัน T-SQL `SET TRANSACTION ISOLATION LEVEL SNAPSHOT` + `BEGIN TRAN`
   * จำเป็นกับตารางนี้เป็นพิเศษ — keyset ปิดท้ายด้วย %%physloc%% ซึ่งคงที่เฉพาะในสแนปช็อตเดียว
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
        `>>> [${key}] คำเตือน: SNAPSHOT ไม่พร้อม (${snapErr instanceof Error ? snapErr.message : String(snapErr)}) — %%physloc%% อาจขยับระหว่างรัน (แถวหาย/ซ้ำ) เปิด ALLOW_SNAPSHOT_ISOLATION ในฐาน MSSQL หรือหยุดเขียนตารางนี้ระหว่าง migrate`,
        uiState,
      );
    }
  }

  const offsetSelectSql = MSSQL_PACS_SYNC_PATIENT_SELECT.replaceAll(
    "{{sourceObject}}",
    sourceRef,
  ).replaceAll("{{orderBy}}", MSSQL_PACS_SYNC_PATIENT_ORDER_BY);
  const keysetSelectSql = buildMssqlPacsSyncPatientKeysetSelect().replaceAll(
    "{{sourceObject}}",
    sourceRef,
  );

  let sourceRowCountTotal = sourceLimit;
  if (sourceRowCountTotal == null && progressEnabled) {
    try {
      const countRes = await mssqlRequest().query(
        `SELECT COUNT_BIG(1) AS total FROM ${sourceRef}`,
      );
      sourceRowCountTotal = Number(countRes.recordset?.[0]?.total ?? 0);
    } catch {
      sourceRowCountTotal = null;
    }
  }
  if (useMssqlKeyset && repairSourceIds == null) {
    offset = await reconcileResumeOffsetByAfterCount(mssqlRequest, {
      tableLabel: key,
      fromSql: sourceRef,
      afterPredicate: MSSQL_PACS_SYNC_PATIENT_KEYSET_AFTER_PREDICATE,
      bind: (req) => bindKeysetInputs(req, mssqlKeysetAfter),
      offset,
      migrationConfig,
      indexLimited: idx.indexLimited,
    });
  }
  const plannedRows = prepareMigrateRowPlan({
    migrationConfig,
    sourceRowCountTotal,
    offset,
    indexLimited: idx.indexLimited,
    sourceIndexFrom: idx.sourceIndexFrom,
    sourceIndexTo: idx.sourceIndexTo,
  });
  const progressTotal = plannedRows ?? null;
  const plannedChunks =
    plannedRows != null && plannedRows > 0
      ? Math.ceil(plannedRows / batchSize)
      : null;
  if (plannedChunks != null) {
    writeOutLine(
      `>>> [${key}] plan: ${plannedRows} rows, ~${plannedChunks} chunks`,
      uiState,
    );
  }

  writeOutLine(
    `>>> [${key}] source: ${sourceObject} → target public.pacs_sync_patient (batchSize=${batchSize})`,
    uiState,
  );
  writeOutLine(
    `>>> [${key}] start offset: ${offset}${
      useMssqlKeyset
        ? " (MSSQL keyset ASC: UpdateTime→PID→%%physloc%%)"
        : " (MSSQL OFFSET ASC)"
    }`,
    uiState,
  );
  writeOutLine(
    `>>> [${key}] insert ทุกแถวจาก MSSQL (ไม่ dedupe / ไม่ลบของเดิม) — รันทับชุดเดิมต้อง TRUNCATE ปลายทางเองก่อน`,
    uiState,
  );
  if (String(migrationConfig.migrateRowMode ?? "") === "overwrite") {
    writeOutLine(
      `>>> [${key}] หมายเหตุ: migrateRowMode=overwrite ไม่มีผลกับตารางนี้ — ไม่มีคีย์ธรรมชาติให้เขียนทับ`,
      uiState,
    );
  }

  let total = 0;
  let totalRowsWritten = 0;
  const fieldIssueAcc = createFieldIssueAccumulator("log_key");
  const fieldIssueLogPath = path.join(
    logsDir,
    `migration-field-issues-pacs_sync_patient-${nowStamp()}.json`,
  );
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
        plannedRows: plannedRowsForPageSize(
          plannedRows,
          migrationConfig,
          idx.indexLimited,
        ),
      });
      if (pageSize <= 0) break;
      const nextChunkIndex = chunkIndex + 1;
      if (debugLogs) {
        writeOutLine(
          `>>> [${key}] fetch chunk ${nextChunkIndex}: ${
            useMssqlKeyset && !repairBatches
              ? `keyset after ${JSON.stringify(keysetAfterForPersist(mssqlKeysetAfter ?? defaultKeysetAfter()))}`
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
        let r;
        if (useMssqlKeyset) {
          bindKeysetInputs(rq, mssqlKeysetAfter);
          r = await rq.input("page", sql.Int, pageSize).query(keysetSelectSql);
        } else {
          r = await rq
            .input("offset", sql.Int, offset)
            .input("page", sql.Int, pageSize)
            .query(offsetSelectSql);
        }
        fetchElapsedMs = Date.now() - fetchStartedAt;
        rows = r.recordset || [];
        if (debugLogs) {
          writeOutLine(
            `>>> [${key}] fetched rows: ${rows.length} (chunk ${nextChunkIndex}, mssql_query_ms=${fetchElapsedMs})`,
            uiState,
          );
        }
      }

      if (rows.length === 0) break;

      rows = trimRowsToMigrateCap(
        rows,
        total,
        plannedRows,
        migrationConfig,
        idx.indexLimited,
      );
      if (rows.length === 0) break;

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
        step = "run pacs_sync_patient post-load";
        const postLoadResult = await runPacsSyncPatientChunkPostLoad(
          pgClient,
          rows,
        );
        mergeFieldIssueChunk(fieldIssueAcc, postLoadResult);
        totalRowsWritten += postLoadResult.rowsWritten ?? 0;
        step = "COMMIT";
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
          mssqlKeysetAfter = keysetAfterFromRow(rows[n - 1]);
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

      const isLastPage = shouldStopMigratePagination({
        advance: n,
        pageSize,
        rowsReadInWindow: total,
        plannedRows,
        migrationConfig,
        indexLimited: idx.indexLimited,
      });
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

  if (plannedRows != null && plannedRows > 0 && total < plannedRows) {
    writeOutLine(
      `>>> [${key}] คำเตือน: อ่าน MSSQL ${total}/${plannedRows} (ขาด ${plannedRows - total}) — ${
        mssqlSnapshotIsolationActive
          ? "ภายใต้ SNAPSHOT ไม่ควรเกิด ควรตรวจ keyset แล้วแจ้งทีม"
          : "ลบ checkpoints/ แล้ว TRUNCATE ตาราง รัน overwrite ทับชุดเดิมอีกครั้ง"
      }`,
      uiState,
    );
  }
  if (
    plannedRows != null &&
    plannedRows > 0 &&
    total > plannedRows &&
    !mssqlSnapshotIsolationActive
  ) {
    writeOutLine(
      `>>> [${key}] คำเตือน: อ่าน MSSQL ${total}/${plannedRows} (เกิน ${total - plannedRows}) — เมื่อไม่มี SNAPSHOT: COUNT เป็นค่า ณ วินาทีเดียว ถ้ามีแถว log ใหม่เข้ามาระหว่างรันจะอ่านได้มากกว่า COUNT แรกเป็นปกติ`,
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

  await syncPacsSyncPatientIdSequence(pgClient);
  await ensurePacsSyncPatientTargetIndexes(pgClient);

  let fieldIssueLogWritten = null;
  if (fieldIssueAcc.totalFieldIssueCount > 0) {
    const payload = buildFieldIssueLogPayload(fieldIssueAcc, {
      migrationKey: key,
      logType: "pacs_sync_patient_field_issues",
      recordIdKey: "log_key",
      buildRecord: (rec) => ({
        log_key: String(rec.log_key),
        update_time: rec.update_time ?? null,
        pid: rec.pid ?? null,
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
          REPAIR_SPEC_PACS_SYNC_PATIENT,
          repairSourceIds,
          {
            notFoundInSourceIds: repairNotFoundInSource,
            fieldIssueAcc,
          },
        )
      : null;

  writeOutLine(
    `>>> [${key}] done, MSSQL read: ${total}, Postgres inserted: ${totalRowsWritten}`,
    uiState,
  );
  return {
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
}

async function main() {
  const configPath = path.resolve(process.cwd(), getConfigPath());
  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const config = resolveRuntimeConfig(rawConfig, KEY);
  const migrationForJob = mergeMigrationWithCli(config?.migration, KEY);

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
      const result = await runPacsSyncPatientTableJob({
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
