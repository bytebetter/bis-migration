import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import pg from "pg";
import {
  MSSQL_PROCEDURE_BY_OLD_DB_IDS_SELECT,
  MSSQL_PROCEDURE_SELECT,
  createMssqlProcedureSelectBundle,
} from "./mssqlProcedureSelect.mjs";
import { setupCreatedDateMigrationSort } from "../../shared/js-migrate/setupCreatedDateMigrationSort.mjs";
import { ensureProcedurePipelineDdl } from "./procedurePgDdl.mjs";
import { runProcedureChunkPostLoad } from "./procedureMapping.mjs";
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
  markProgressInline,
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
  plannedRowsForPageSize,
  trimRowsToMigrateCap,
} from "../../shared/js-migrate/sourceIndexRange.mjs";
import { prepareMigrateRowPlan } from "../../shared/js-migrate/sourceCountSnapshot.mjs";
import { fetchMssqlRowsByIds } from "../../shared/js-migrate/fetchMssqlByIds.mjs";
import { REPAIR_SPEC_PROCEDURE } from "../../shared/js-migrate/migrateTableSpecs.mjs";
import {
  finalizeRepairFromLog,
  noteRepairBatchNotFoundInSource,
} from "../../shared/js-migrate/repairSummary.mjs";
import {
  batchIds,
  resolveMigrationSourceIds,
} from "../../shared/js-migrate/repairFromLog.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = "procedure";

const PROCEDURE_COLUMNS = [
  "exam_id",
  "biopsy_id",
  "exam_date",
  "pid",
  "radiologist",
  "clinical",
  "finding",
  "location",
  "biopsy_proc",
  "biopsy_proc_des",
  "needle_no",
  "technique",
  "technique_des",
  "patient_pos",
  "patient_pos_des",
  "breast_compress",
  "breast_compress_des",
  "approach",
  "approach_des",
  "spontaneous_discharge",
  "result_aspiration_cc",
  "result_aspiration_app",
  "result_aspiration_app_des",
  "result_aspiration_cytology",
  "result_aspiration_culture",
  "result_corebiopsy_specimens",
  "result_corebiopsy_microcal",
  "result_needle_within_lesion",
  "result_needle_mm_depth",
  "result_needle_mm_near",
  "result_needle_other",
  "result_ductography",
  "result_ductography_des",
  "result_ductography_other",
  "result_smear_noofslide",
  "result_smear_app",
  "result_smear_app_des",
  "assessment_birads",
  "assessment_birads_des",
  "assessment_others",
  "assessment_others_des",
  "recommend",
  "recommend_des",
  "recommend_benign",
  "recommend_benign_des",
  "recommend_highrisk",
  "recommend_highrisk_des",
  "recommend_malignant",
  "recommend_malignant_des",
  "summary_doctor",
  "summary_doctor_name",
  "special_case",
  "special_case_point_des",
  "special_case_point",
  "special_case_detail",
  "patho_code",
  "patho_code_full_des",
  "patho_code_fill_by",
  "patho_code_result_date",
  "is_final",
  "patient_type",
  "patient_type_des",
  "remark",
  "remark_other",
  "remark_text",
  "width",
  "depth",
  "corrected",
  "corrected_date",
  "location_left_other",
  "location_right_other",
  "last_exam_id",
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
    if (selectedProfile === "procedure") {
      process.stdout.write(
        ">>> เธเธณเน€เธ•เธทเธญเธ: เนเธกเนเธเธ profiles.procedure เนเธ config โ€” เนเธเน shared เธญเธขเนเธฒเธเน€เธ”เธตเธขเธง (เนเธเธฐเธเธณเธเธฑเธ”เธฅเธญเธเธเธฒเธ migration.config.example.json)",
        +"\n",
      );
      profileConfig = {};
    } else {
      throw new Error(
        `Profile '${selectedProfile}' not found in config.profiles โ€” เธ•เธฃเธงเธเธชเธญเธ --profile`,
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
      "MSSQL: เธเธณเธซเธเธ” source.password เนเธ migration.config.local.json",
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

function getExamBiopsyLog(row) {
  if (!row) return "";
  const ex = row.exam_id ?? row.EXAM_ID ?? row.Exam_ID;
  const bid = row.biopsy_id ?? row.BIOPSY_ID ?? row.BiopsyID;
  return `${String(ex ?? "")}:${String(bid ?? "")}`;
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

async function runProcedureTableJob({
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
  const indexCkSuffix = buildIndexCheckpointSuffix(migrationConfig);
  const checkpointPath = path.join(
    checkpointDir,
    `${key}${indexCkSuffix}.json`,
  );
  const checkpoint = readJsonIfExists(checkpointPath, {
    key,
    offset: 0,
    completed: false,
    updatedAt: null,
  });
  let offset = Number(
    migrationConfig.startOffset ?? (checkpointEnabled ? checkpoint.offset : 0),
  );
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  const idx = applySourceIndexToMigrateJob({
    key,
    migrationConfig,
    checkpointEnabled,
    offset,
    useMssqlKeyset: false,
  });
  offset = idx.offset;

  const sourceSchema = source?.schema ?? "dbo";
  const sourceTable = source?.table ?? "biopsy";
  const sourceObject = `${bracketIdent(sourceSchema)}.${bracketIdent(sourceTable)}`;
  const sortBundle = await setupCreatedDateMigrationSort(mssqlPool, {
    migrationConfig,
    sourceSchema,
    sourceTable,
    tableLabel: key,
    createSelectBundle: createMssqlProcedureSelectBundle,
  });
  const biopsyOrderExpr = sortBundle.orderBy;

  const selectSql = MSSQL_PROCEDURE_SELECT.replaceAll(
    "{{sourceObject}}",
    sourceObject,
  ).replaceAll("{{orderBy}}", biopsyOrderExpr);
  const repairDetailTemplate = MSSQL_PROCEDURE_BY_OLD_DB_IDS_SELECT.replaceAll(
    "{{sourceObject}}",
    sourceObject,
  );
  const logsDir = path.resolve(__dirname, "logs");
  const repairSourceIds = resolveMigrationSourceIds(
    migrationConfig,
    logsDir,
    REPAIR_SPEC_PROCEDURE,
  );
  const repairBatches =
    repairSourceIds != null ? [...batchIds(repairSourceIds, batchSize)] : null;
  let repairBatchIndex = 0;
  const repairNotFoundInSource =
    repairSourceIds != null ? new Set() : null;
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
    const idPlan = plannedProgressForSourceIds(repairSourceIds, batchSize);
    if (idPlan) {
      plannedRows = idPlan.plannedRows;
      plannedChunks = idPlan.plannedChunks;
      progressTotal = idPlan.plannedRows;
    }
    logByIdMigrationRun(
      key,
      repairSourceIds.length,
      "old_db_id",
      migrationConfig,
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
  const probeTiming = migrationConfig.probeTiming === true;
  const progressEnabled = migrationConfig.progressUi !== false;
  const progressStartedAt = Date.now();
  const debugLogs = migrationConfig.debugLogs === true || probeTiming;
  const uiState = createUiState();
  let sourceRowCountTotal = sourceLimit;
  if (sourceRowCountTotal == null && progressEnabled) {
    try {
      const countRes = await mssqlPool
        .request()
        .query(`SELECT COUNT_BIG(1) AS total FROM ${sourceObject};`);
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
    `>>> [${key}] start offset: ${offset} (OFFSET เธ•เธฒเธก [Exam_ID],[BiopsyID])`,
    uiState,
  );
  await ensureProcedurePipelineDdl(pgClient);

  let total = 0;
  const fieldIssueAcc = createFieldIssueAccumulator("old_db_id");
  const fieldIssueLogPath = path.join(
    path.resolve(__dirname, "logs"),
    `migration-field-issues-procedure-${nowStamp()}.json`,
  );
  fs.mkdirSync(path.dirname(fieldIssueLogPath), { recursive: true });
  const chunkResults = [];
  let chunkIndex = 0;
  let successChunkCount = 0;
  let failedChunkCount = 0;

  while (true) {
    const chunkT0 = Date.now();
    const pageSize = resolvePageSize({
      batchSize,
      total,
      sourceLimit,
      plannedRows: plannedRowsForPageSize(plannedRows, migrationConfig, idx.indexLimited),
    });
    if (pageSize <= 0) break;
    const nextChunkIndex = chunkIndex + 1;
    if (debugLogs) {
      writeOutLine(
        `>>> [${key}] fetch chunk ${nextChunkIndex}: offset=${offset} pageSize=${pageSize}`,
        uiState,
      );
    }

    let rows = [];
    let fetchElapsedMs = 0;
    if (repairBatches) {
      if (repairBatchIndex >= repairBatches.length) break;
      const idBatch = repairBatches[repairBatchIndex++];
      const fetchStartedAt = Date.now();
      rows = await fetchMssqlRowsByIds(mssqlPool, sql, {
        ids: idBatch.map((k) => String(k).replace(":", "_")),
        detailSqlTemplate: repairDetailTemplate,
        idType: "nvarchar",
        nvarcharLength: 80,
      });
      fetchElapsedMs = Date.now() - fetchStartedAt;
      if (repairNotFoundInSource) {
        noteRepairBatchNotFoundInSource(
          repairNotFoundInSource,
          idBatch,
          rows,
          (r) => getExamBiopsyLog(r),
        );
      }
      if (rows.length === 0) continue;
    } else {
      const fetchStartedAt = Date.now();
      const req = mssqlPool.request();
      bindMigrateSrcNumericRange(req, migrationConfig, sql);
      const r = await req
        .input("offset", sql.Int, offset)
        .input("page", sql.Int, pageSize)
        .query(selectSql);
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
          `>>> [${key}] no more rows (mssql ${Date.now() - fetchStartedAt}ms); chunk wall ${Date.now() - chunkT0}ms`,
          uiState,
        );
      }
      break;
    }

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
    const firstKey = getExamBiopsyLog(rows[0]);
    const lastKey = getExamBiopsyLog(rows[n - 1]);
    const arrays = PROCEDURE_COLUMNS.map(() => new Array(n));
    for (let i = 0; i < n; i++) {
      rowToStagingArrays(rows[i], i, arrays, PROCEDURE_COLUMNS);
    }

    let step = "begin chunk transaction";
    let lastChunkProcessMs = 0;
    try {
      await pgClient.query("BEGIN");
      step = "truncate staging";
      await pgClient.query("TRUNCATE TABLE migrate_stg.biopsy_mssql;");
      step = "insert staging";
      const unnestArgs = arrays
        .map((_, idx) => `$${idx + 1}::text[]`)
        .join(", ");
      await pgClient.query(
        `INSERT INTO migrate_stg.biopsy_mssql (${PROCEDURE_COLUMNS.join(", ")}) SELECT * FROM unnest(${unnestArgs});`,
        arrays,
      );
      step = "run procedure post-load (map -> public.procedure)";
      const postLoadResult = await runProcedureChunkPostLoad(pgClient, rows);
      mergeFieldIssueChunk(fieldIssueAcc, postLoadResult);
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
    if (!repairBatches) offset += n;
    if (checkpointEnabled && !repairBatches) {
      writeJson(checkpointPath, {
        key,
        offset,
        completed: false,
        updatedAt: new Date().toISOString(),
      });
    }
    const isLastPage =
      isIndexWindowComplete({
        indexLimited: idx.indexLimited,
        migrationConfig,
        plannedRows,
        rowsReadInWindow: total,
      }) || n < pageSize;
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
    for (let i = 0; i < arrays.length; i++) arrays[i].length = 0;
    rows.length = 0;
    if (isLastPage) break;
  }

  if (progressEnabled) endProgress(uiState);

  if (checkpointEnabled) {
    writeJson(checkpointPath, {
      key,
      offset,
      completed: true,
      updatedAt: new Date().toISOString(),
    });
  }

  let fieldIssueLogWritten = null;
  if (fieldIssueAcc.totalFieldIssueCount > 0) {
    const payload = buildFieldIssueLogPayload(fieldIssueAcc, {
      migrationKey: key,
      logType: "procedure_field_issues",
      recordIdKey: "old_db_id",
      buildRecord: (rec) => ({
        old_db_id: String(rec.old_db_id),
        exam_id: rec.exam_id ?? null,
        biopsy_id: rec.biopsy_id ?? null,
        exam_pg_id: rec.exam_pg_id ?? null,
        fieldIssues: rec.fieldIssues ?? [],
      }),
    });
    writeFieldIssueLogFile(fieldIssueLogPath, payload);
    fieldIssueLogWritten = fieldIssueLogPath;
  }

  const repairSummary =
    repairSourceIds != null
      ? finalizeRepairFromLog(key, REPAIR_SPEC_PROCEDURE, repairSourceIds, {
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
  writeOutLine(`>>> [${key}] done, total rows read: ${total}`, uiState);
  return summary;
}

async function main() {
  const configPath = path.resolve(process.cwd(), getConfigPath());
  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const config = resolveRuntimeConfig(rawConfig, "procedure");
  const migrationForJob = mergeMigrationWithCli(config?.migration, "procedure");
  if (migrationForJob.batchSize == null) {
    migrationForJob.batchSize = 2000;
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
      const result = await runProcedureTableJob({
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
