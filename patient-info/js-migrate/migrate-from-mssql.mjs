import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import pg from "pg";
import {
  MSSQL_PATIENT_INFO_BY_PIDS_SELECT,
  MSSQL_PATIENT_INFO_SELECT,
} from "./mssqlPatientInfoSelect.mjs";
import {
  ensurePatientInfoShortNoteColumn,
  ensurePatientInfoStagingDdl,
} from "./patientInfoPgDdl.mjs";
import {
  buildFieldIssueLogPayload,
  createFieldIssueAccumulator,
  mergeFieldIssueChunk,
  writeFieldIssueLogFile,
} from "../../shared/js-migrate/fieldIssueLog.mjs";
import {
  distinctOnNormPid,
  normPid,
  runPatientInfoChunkPostLoad,
} from "./patientInfoMapping.mjs";
import {
  createUiState,
  endProgress,
  markProgressInline,
  renderProgress,
  writeOutLine,
} from "../../shared/js-migrate/progressUi.mjs";
import { mergeMigrationWithCli } from "../../shared/js-migrate/mergeMigrationConfig.mjs";
import { fetchMssqlRowsByIds } from "../../shared/js-migrate/fetchMssqlByIds.mjs";
import { REPAIR_SPEC_PATIENT_INFO } from "../../shared/js-migrate/migrateTableSpecs.mjs";
import {
  batchIds,
  resolveRepairSourceIds,
} from "../../shared/js-migrate/repairFromLog.mjs";
import {
  finalizeRepairFromLog,
  noteRepairBatchNotFoundInSource,
} from "../../shared/js-migrate/repairSummary.mjs";


const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
 * Tedious: requestTimeout เธ”เธตเธเธญเธฅเธ•เน 15s โ€” เธเนเธญเธกเธนเธฅเน€เธขเธญเธฐ/เน€เธเนเธ•เธเนเธฒ เนเธซเนเนเธเน 0 = เนเธกเนเธเธณเธเธฑเธ”
 * เธ–เนเธฒ request เธซเธกเธ”เน€เธงเธฅเธฒเนเธฅเนเธง cancel เธเนเธฒ: error "Failed to cancel in 5000ms" โ€” เนเธเน cancelTimeout: 0
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
      "MSSQL: เธเธณเธซเธเธ” source.password เนเธ migration.config.local.json (shared เธซเธฃเธทเธญ profile) เนเธซเนเน€เธเนเธเธฃเธซเธฑเธชเธเธฃเธดเธ โ€” เธขเธฑเธเนเธเน placeholder YOUR_MSSQL_PASSWORD เธซเธฃเธทเธญเน€เธงเนเธเธงเนเธฒเธเธญเธขเธนเน",
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

function pidFromMssqlRow(r) {
  if (r == null) return "";
  return normPid(r.pid ?? r.PID ?? r.Pid);
}

/**
 * เธ—เธ”เธฅเธญเธ post-load เธเธธเธ”เธขเนเธญเธขเนเธ txn เนเธฅเนเธง ROLLBACK เน€เธชเธกเธญ โ€” เนเธเนเธซเธฒ PID เธ—เธตเนเธ—เธณเนเธซเน INSERT เธเธฑเธ
 */
async function dryRunPatientInfoPostLoadSubset(
  pgClient,
  stagingTable,
  columns,
  subsetRows,
  rowToStagingArraysFn,
) {
  const n = subsetRows.length;
  await pgClient.query("BEGIN");
  try {
    await pgClient.query(`TRUNCATE TABLE ${stagingTable};`);
    if (n === 0) {
      await pgClient.query("ROLLBACK");
      return true;
    }
    const arrays = columns.map(() => new Array(n));
    for (let i = 0; i < n; i++) {
      rowToStagingArraysFn(subsetRows[i], i, arrays, columns);
    }
    const unnestArgs = arrays.map((_, idx) => `$${idx + 1}::text[]`).join(", ");
    const insertStaging = `INSERT INTO ${stagingTable} (${columns.join(", ")}) SELECT * FROM unnest(${unnestArgs});`;
    await pgClient.query(insertStaging, arrays);
    await runPatientInfoChunkPostLoad(pgClient, subsetRows);
    await pgClient.query("ROLLBACK");
    return true;
  } catch {
    try {
      await pgClient.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    return false;
  }
}

async function bisectPatientInfoPostLoadOffenders(
  pgClient,
  stagingTable,
  columns,
  dedupedRows,
  rowToStagingArraysFn,
) {
  if (dedupedRows.length === 0) return [];
  const fails = async (subset) =>
    !(await dryRunPatientInfoPostLoadSubset(
      pgClient,
      stagingTable,
      columns,
      subset,
      rowToStagingArraysFn,
    ));
  if (dedupedRows.length === 1) {
    return (await fails(dedupedRows)) ? dedupedRows : [];
  }
  const mid = Math.floor(dedupedRows.length / 2);
  const left = dedupedRows.slice(0, mid);
  const right = dedupedRows.slice(mid);
  if (await fails(left)) {
    return bisectPatientInfoPostLoadOffenders(
      pgClient,
      stagingTable,
      columns,
      left,
      rowToStagingArraysFn,
    );
  }
  if (await fails(right)) {
    return bisectPatientInfoPostLoadOffenders(
      pgClient,
      stagingTable,
      columns,
      right,
      rowToStagingArraysFn,
    );
  }
  return [];
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
  // Allow existing SQL files with BEGIN/COMMIT to run in one outer transaction.
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

function buildTableJobs(config) {
  if (Array.isArray(config.tables) && config.tables.length > 0)
    return config.tables;

  // Backward compatibility with previous single-table config.
  return [
    {
      key: "patient_info",
      sourceSchema: config.source?.schema ?? "dbo",
      sourceTable: config.source?.table ?? "patient_info",
      orderBy: "[PID]",
      columns: [
        "pid",
        "prefix",
        "name",
        "surname",
        "date_of_birth_be",
        "single",
        "address",
        "sub_area",
        "area",
        "province",
        "zip",
        "phone_biz",
        "phone_home",
        "height",
        "weight",
        "current_breast_compo",
        "current_implant_type",
        "last_exam_date",
        "mobile",
        "mobile_updated",
        "donate_type",
        "eng_prefix",
        "eng_name",
        "eng_surname",
        "soc_id",
        "hn",
        "gender",
        "address2",
        "short_note",
        "disease",
        "mobile_phone",
        "email",
      ],
      stagingTable: "migrate_stg.patient_info_mssql",
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
  const orderBy = tableJob.orderBy ?? "[PID]";
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
  const checkpointPath = path.join(checkpointDir, `${key}.json`);

  const isPatientInfoBuiltin =
    key === "patient_info" ||
    (tableJob.sourceTable === "patient_info" && !tableJob.key);
  if (!sourceTable || !stagingTable || columns.length === 0) {
    throw new Error(`Table job '${key}' is incomplete`);
  }
  if (!selectSqlFile && !isPatientInfoBuiltin) {
    throw new Error(
      `Table job '${key}' is incomplete: set selectSqlFile or use key/sourceTable patient_info for built-in SELECT`,
    );
  }

  const sourceObject = `${bracketIdent(sourceSchema)}.${bracketIdent(sourceTable)}`;
  const selectTemplate = selectSqlFile
    ? readSql(sqlBaseDir, selectSqlFile)
    : MSSQL_PATIENT_INFO_SELECT;
  const selectSql = selectTemplate
    .replaceAll("{{sourceObject}}", sourceObject)
    .replaceAll("{{orderBy}}", orderBy);

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
  const progressEnabled = migrationConfig.progressUi !== false;
  const debugLogs = migrationConfig.debugLogs === true;
  const progressStartedAt = Date.now();
  const uiState = createUiState();
  if (debugLogs) writeOutLine(`>>> [${key}] start offset: ${offset}`, uiState);
  let plannedRows = null;
  if (progressEnabled) {
    try {
      const countRes = await mssqlPool
        .request()
        .query(`SELECT COUNT_BIG(1) AS total FROM ${sourceObject};`);
      plannedRows = Number(countRes.recordset?.[0]?.total ?? 0);
    } catch {
      plannedRows = null;
    }
  }
  const plannedChunks =
    plannedRows != null && plannedRows > 0
      ? Math.ceil(plannedRows / batchSize)
      : null;
  if (debugLogs && plannedRows != null && plannedChunks != null) {
    writeOutLine(
      `>>> [${key}] plan: ~${plannedRows} rows, ~${plannedChunks} chunks`,
      uiState,
    );
  }

  if (isPatientInfoBuiltin && toArray(tableJob.preLoadSqlFiles).length === 0) {
    writeOutLine(`>>> [${key}] ensure migrate_stg + norm_pid (DDL)`, uiState);
    await ensurePatientInfoStagingDdl(pgClient);
    await ensurePatientInfoShortNoteColumn(pgClient);
  }
  for (const sqlFile of toArray(tableJob.preLoadSqlFiles)) {
    if (debugLogs)
      writeOutLine(`>>> [${key}] run pre-load SQL: ${sqlFile}`, uiState);
    await pgClient.query(readSql(sqlBaseDir, sqlFile));
  }

  let total = 0;
  let sourceCases = 0;
  let patientSuccessCases = 0;
  let patientFailCases = 0;
  let addressSuccessCases = 0;
  const failedPidSet = new Set();
  const fieldIssueAcc = isPatientInfoBuiltin
    ? createFieldIssueAccumulator("pid")
    : null;
  const fieldIssueLogPath = isPatientInfoBuiltin
    ? path.join(
        path.resolve(__dirname, "logs"),
        `migration-field-issues-${String(key).replace(/[^a-zA-Z0-9_-]/g, "_")}-${nowStamp()}.json`,
      )
    : null;
  const chunkResults = [];
  let chunkIndex = 0;

  const logsDir = path.resolve(sqlBaseDir, "logs");
  const repairSourceIds = resolveRepairSourceIds(
    migrationConfig,
    logsDir,
    REPAIR_SPEC_PATIENT_INFO,
  );
  const repairBatches =
    repairSourceIds != null ? [...batchIds(repairSourceIds, batchSize)] : null;
  let repairBatchIndex = 0;
  const repairNotFoundInSource =
    repairSourceIds != null ? new Set() : null;
  if (repairSourceIds != null && repairSourceIds.length === 0) {
    console.error(`>>> [${key}] repair-from-log: ไม่มี pid ให้ migrate`);
    return {
      key,
      totalRowsRead: 0,
      fieldIssueLogPath: null,
      checkpointPath: checkpointEnabled ? checkpointPath : null,
      chunkCount: 0,
      chunkResults: [],
      repairSummary: finalizeRepairFromLog(key, REPAIR_SPEC_PATIENT_INFO, [], {}),
    };
  }
  if (repairSourceIds != null) {
    console.error(
      `>>> [${key}] migrateRunMode=repair-from-log (${repairSourceIds.length} pid)`,
    );
  }
  const pidDetailTemplate = MSSQL_PATIENT_INFO_BY_PIDS_SELECT.replaceAll(
    "{{sourceObject}}",
    sourceObject,
  );

  while (true) {
    let rows = [];
    if (repairBatches) {
      if (repairBatchIndex >= repairBatches.length) break;
      const pidBatch = repairBatches[repairBatchIndex++];
      rows = await fetchMssqlRowsByIds(mssqlPool, sql, {
        ids: pidBatch,
        detailSqlTemplate: pidDetailTemplate,
        idType: "nvarchar",
        nvarcharLength: 50,
      });
      if (repairNotFoundInSource) {
        noteRepairBatchNotFoundInSource(
          repairNotFoundInSource,
          pidBatch,
          rows,
          (r) => normPid(r.pid),
        );
      }
      if (rows.length === 0) continue;
    } else {
      const r = await mssqlPool
        .request()
        .input("offset", sql.Int, offset)
        .input("page", sql.Int, batchSize)
        .query(selectSql);
      rows = r.recordset || [];
      if (rows.length === 0) break;
    }

    const n = rows.length;
    chunkIndex += 1;
    const sourceOffsetStart = offset;
    const sourceOffsetEnd = offset + n - 1;
    const firstPid = normPid(rows[0]?.pid);
    const lastPid = normPid(rows[n - 1]?.pid);
    const arrays = columns.map(() => new Array(n));
    for (let i = 0; i < n; i++) rowToStagingArrays(rows[i], i, arrays, columns);

    let step = "begin chunk transaction";
    try {
      await pgClient.query("BEGIN");
      step = "truncate staging table";
      await pgClient.query(`TRUNCATE TABLE ${stagingTable};`);

      step = "insert chunk into staging";
      const unnestArgs = arrays
        .map((_, idx) => `$${idx + 1}::text[]`)
        .join(", ");
      const insertStaging = `INSERT INTO ${stagingTable} (${columns.join(", ")}) SELECT * FROM unnest(${unnestArgs});`;
      await pgClient.query(insertStaging, arrays);

      if (toArray(tableJob.postLoadSqlFiles).length > 0) {
        for (const sqlFile of toArray(tableJob.postLoadSqlFiles)) {
          step = `run post-load SQL: ${sqlFile}`;
          if (debugLogs) {
            writeOutLine(`>>> [${key}] run post-load SQL: ${sqlFile}`, uiState);
          }
          const postSql = stripTxWrappers(readSql(sqlBaseDir, sqlFile));
          await pgClient.query(postSql);
        }
      } else if (isPatientInfoBuiltin) {
        step = "run patient_info JS post-load (map -> public + address)";
        if (debugLogs) {
          writeOutLine(`>>> [${key}] runPatientInfoChunkPostLoad`, uiState);
        }
        const postLoadResult = await runPatientInfoChunkPostLoad(
          pgClient,
          rows,
          {
            migrationKey: key,
            chunkIndex,
            migrateRowMode: migrationConfig.migrateRowMode ?? "overwrite",
          },
        );
        mergeFieldIssueChunk(fieldIssueAcc, postLoadResult);
        for (const pid of postLoadResult?.failedPids ?? [])
          failedPidSet.add(pid);
      }

      step = "compute chunk stats";
      const stats = await pgClient.query(`
WITH src AS (
  SELECT DISTINCT migrate_stg.norm_pid(pid) AS npid
  FROM migrate_stg.patient_info_mssql
  WHERE migrate_stg.norm_pid(pid) <> ''
),
matched AS (
  SELECT DISTINCT migrate_stg.norm_pid(p.pid::text) AS npid
  FROM public.patient_info p
  JOIN src s ON s.npid = migrate_stg.norm_pid(p.pid::text)
),
addr AS (
  SELECT COUNT(*)::int AS cnt
  FROM public.address a
  JOIN public.patient_info p ON p.id = a.patient_info
  JOIN src s ON s.npid = migrate_stg.norm_pid(p.pid::text)
)
SELECT
  (SELECT COUNT(*)::int FROM src) AS source_cases,
  (SELECT COUNT(*)::int FROM matched) AS patient_success_cases,
  ((SELECT COUNT(*)::int FROM src) - (SELECT COUNT(*)::int FROM matched)) AS patient_fail_cases,
  (SELECT cnt FROM addr) AS address_success_cases;
`);

      const failedRows = await pgClient.query(`
WITH src AS (
  SELECT DISTINCT migrate_stg.norm_pid(pid) AS npid
  FROM migrate_stg.patient_info_mssql
  WHERE migrate_stg.norm_pid(pid) <> ''
),
matched AS (
  SELECT DISTINCT migrate_stg.norm_pid(p.pid::text) AS npid
  FROM public.patient_info p
  JOIN src s ON s.npid = migrate_stg.norm_pid(p.pid::text)
)
SELECT s.npid AS pid
FROM src s
LEFT JOIN matched m ON m.npid = s.npid
WHERE m.npid IS NULL
ORDER BY s.npid
LIMIT 200;
`);

      const chunkStats = stats.rows[0] ?? {};
      sourceCases += Number(chunkStats.source_cases ?? 0);
      patientSuccessCases += Number(chunkStats.patient_success_cases ?? 0);
      patientFailCases += Number(chunkStats.patient_fail_cases ?? 0);
      addressSuccessCases += Number(chunkStats.address_success_cases ?? 0);
      for (const row of failedRows.rows) {
        if (failedPidSet.size >= 200) break;
        failedPidSet.add(row.pid);
      }

      await pgClient.query("COMMIT");
      chunkResults.push({
        chunkIndex,
        status: "success",
        sourceOffsetStart,
        sourceOffsetEnd,
        rowCount: n,
        firstPid,
        lastPid,
        source_cases: Number(chunkStats.source_cases ?? 0),
        patient_success_cases: Number(chunkStats.patient_success_cases ?? 0),
        patient_fail_cases: Number(chunkStats.patient_fail_cases ?? 0),
        address_success_cases: Number(chunkStats.address_success_cases ?? 0),
      });
    } catch (err) {
      await pgClient.query("ROLLBACK");
      const detail = err instanceof Error ? err.message : String(err);
      const postLoadStep =
        "run patient_info JS post-load (map -> public + address)";
      /** @type {string[]} */
      let bisectOffendingPids = [];
      if (
        isPatientInfoBuiltin &&
        step === postLoadStep &&
        columns.length > 0 &&
        stagingTable
      ) {
        try {
          const workRows = distinctOnNormPid(rows);
          const badRows = await bisectPatientInfoPostLoadOffenders(
            pgClient,
            stagingTable,
            columns,
            workRows,
            rowToStagingArrays,
          );
          bisectOffendingPids = badRows
            .map((r) => pidFromMssqlRow(r))
            .filter((p) => p !== "");
        } catch {
          /* ignore bisect errors */
        }
      }
      chunkResults.push({
        chunkIndex,
        status: "failed",
        sourceOffsetStart,
        sourceOffsetEnd,
        rowCount: n,
        firstPid,
        lastPid,
        failedAtStep: step,
        error: detail,
        bisectOffendingPids,
      });

      const migrationFailure = {
        tableKey: key,
        chunkIndex,
        sourceOffsetStart,
        sourceOffsetEnd,
        firstPid,
        lastPid,
        bisectOffendingPids,
        failedAtStep: step,
        postgresDetail: detail,
      };

      writeOutLine(
        `>>> [${key}] FAILED chunk ${chunkIndex} | step: ${step}`,
        uiState,
      );
      const focusPidStr =
        bisectOffendingPids.length === 1
          ? bisectOffendingPids[0]
          : bisectOffendingPids.length > 1
            ? bisectOffendingPids.join(", ")
            : "";
      writeOutLine(
        `>>> [${key}] WHERE_TO_FIX เนเธเนเธเนเธญเธกเธนเธฅ MSSQL PID=${focusPidStr || `(เธเนเธงเธ ${firstPid}..${lastPid} โ€” bisect เนเธกเนเธเธตเนเนเธ–เธงเน€เธ”เธตเธขเธง)`} | pid_range ${firstPid}..${lastPid} | row_offset ${sourceOffsetStart}-${sourceOffsetEnd}`,
        uiState,
      );
      writeOutLine(`>>> [${key}] postgres: ${detail}`, uiState);
      if (
        bisectOffendingPids.length === 0 &&
        step === postLoadStep &&
        distinctOnNormPid(rows).length > 1
      ) {
        writeOutLine(
          `>>> [${key}] hint: เธเนเธเนเธ dbo.patient_info WHERE PID เธญเธขเธนเนเธฃเธฐเธซเธงเนเธฒเธเธเนเธงเธเธ”เนเธฒเธเธเธ เธซเธฃเธทเธญเนเธเน row_offset เน€เธ—เธตเธขเธ ORDER BY เนเธ migrate`,
          uiState,
        );
      }

      let suffix = "";
      if (bisectOffendingPids.length === 1) {
        suffix = ` | offending PID: ${bisectOffendingPids[0]}`;
      } else if (bisectOffendingPids.length > 1) {
        suffix = ` | offending PIDs: ${bisectOffendingPids.join(",")}`;
      }
      const message = `[${key}] failed chunk ${chunkIndex} (offset ${sourceOffsetStart}-${sourceOffsetEnd}, pid ${firstPid}..${lastPid}) at step '${step}': ${detail}${suffix}`;
      /** @type {Error & { migrationFailure?: object }} */
      const migrationErr = new Error(message);
      migrationErr.migrationFailure = migrationFailure;
      throw migrationErr;
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
    if (progressEnabled) {
      renderProgress(
        total,
        plannedRows,
        progressStartedAt,
        chunkIndex,
        plannedChunks,
        uiState,
      );
    } else if (debugLogs) {
      writeOutLine(
        `... [${key}] processed ${total} rows (offset=${offset})`,
        uiState,
      );
    }
    if (rows.length < batchSize) break;
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
  if (
    fieldIssueAcc &&
    fieldIssueLogPath &&
    fieldIssueAcc.totalFieldIssueCount > 0
  ) {
    const payload = buildFieldIssueLogPayload(fieldIssueAcc, {
      migrationKey: key,
      logType: "patient_info_field_issues",
      recordIdKey: "pid",
      buildRecord: (rec) => ({
        pid: String(rec.pid),
        pid_raw: rec.pid_raw ?? String(rec.pid),
        patient_info_id: rec.patient_info_id ?? null,
        fieldIssues: rec.fieldIssues ?? [],
      }),
    });
    writeFieldIssueLogFile(fieldIssueLogPath, payload);
    fieldIssueLogWritten = fieldIssueLogPath;
  }

  const repairSummary =
    repairSourceIds != null
      ? finalizeRepairFromLog(key, REPAIR_SPEC_PATIENT_INFO, repairSourceIds, {
          failedIds: failedPidSet,
          notFoundInSourceIds: repairNotFoundInSource,
          fieldIssueAcc,
        })
      : null;

  const summary = {
    key,
    totalRowsRead: total,
    source_cases: sourceCases,
    patient_success_cases: patientSuccessCases,
    patient_fail_cases: patientFailCases,
    address_success_cases: addressSuccessCases,
    failedPids: Array.from(failedPidSet),
    fieldIssueLogPath: fieldIssueLogWritten,
    checkpointPath: checkpointEnabled ? checkpointPath : null,
    chunkCount: chunkIndex,
    chunkResults,
    repairSummary,
  };

  if (debugLogs) {
    writeOutLine(`>>> [${key}] done, total rows read: ${total}`, uiState);
  }
  return summary;
}

async function main() {
  const configPath = path.resolve(process.cwd(), getConfigPath());
  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const config = resolveRuntimeConfig(rawConfig, "patient_info");
  const migrationConfig = mergeMigrationWithCli(
    config?.migration,
    "patient_info",
  );

  if (!config?.source) {
    throw new Error("Missing source config");
  }
  if (!config?.target) {
    throw new Error("Missing target config");
  }
  const bootUi = createUiState();
  if (config.__profileName) {
    writeOutLine(`>>> using config profile: ${config.__profileName}`, bootUi);
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
          migrationConfig,
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
    if (
      err &&
      typeof err === "object" &&
      "migrationFailure" in err &&
      /** @type {{ migrationFailure?: object }} */ (err).migrationFailure !=
        null
    ) {
      runLog.failureContext = /** @type {{ migrationFailure: object }} */ (
        err
      ).migrationFailure;
    }
    throw err;
  } finally {
    await pool.close();
    await pgPool.end();
    runLog.finishedAt = new Date().toISOString();
    const logPath = path.join(logsDir, `migrate-${nowStamp()}.json`);
    fs.writeFileSync(logPath, `${JSON.stringify(runLog, null, 2)}\n`, "utf8");
    writeOutLine(`>>> migration log saved: ${logPath}`, bootUi);
  }
}

main().catch((err) => {
  // stdout เธญเธฒเธเธกเธตเธเธฃเธฃเธ—เธฑเธ” FAILED เธเธฒเธ runTableJob เนเธฅเนเธง โ€” stderr เน€เธซเธฅเธทเธญเนเธเน stack
  if (err instanceof Error && err.stack) console.error(err.stack);
  else console.error(err);
  process.exit(1);
});
