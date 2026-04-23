import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import pg from "pg";
import { MSSQL_PATIENT_INFO_SELECT } from "./mssqlPatientInfoSelect.mjs";
import { ensurePatientInfoStagingDdl } from "./patientInfoPgDdl.mjs";
import { normPid, runPatientInfoChunkPostLoad } from "./patientInfoMapping.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getConfigPath() {
  const idx = process.argv.indexOf("--config");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return "./config.local.json";
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

function buildMssqlConfig(sourceConfig = {}) {
  if (sourceConfig.mssqlUrl) return parseMssqlUrl(sourceConfig.mssqlUrl);
  return {
    server: sourceConfig.server,
    port: Number(sourceConfig.port ?? 1433),
    database: sourceConfig.database,
    user: sourceConfig.user,
    password: sourceConfig.password,
    options: {
      encrypt: sourceConfig.encrypt !== false,
      trustServerCertificate: sourceConfig.trustServerCertificate !== false,
    },
    pool: { max: 5, min: 0 },
  };
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
  if (Array.isArray(config.tables) && config.tables.length > 0) return config.tables;

  // Backward compatibility with previous single-table config.
  return [
    {
      key: "patient_info",
      sourceSchema: config.source?.schema ?? "dbo",
      sourceTable: config.source?.table ?? "patient_info",
      orderBy: "[PID]",
      columns: [
        "pid", "prefix", "name", "surname", "date_of_birth_be", "single", "address", "sub_area",
        "area", "province", "zip", "phone_biz", "phone_home", "height", "weight",
        "current_breast_compo", "current_implant_type", "last_exam_date", "mobile", "mobile_updated",
        "donate_type", "eng_prefix", "eng_name", "eng_surname", "soc_id", "hn", "gender", "address2",
        "short_note", "disease", "mobile_phone", "email"
      ],
      stagingTable: "migrate_stg.patient_info_mssql",
      postLoadSqlFiles: []
    }
  ];
}

async function runTableJob({ mssqlPool, pgClient, sqlBaseDir, migrationConfig, tableJob }) {
  const key = tableJob.key ?? `${tableJob.sourceSchema}.${tableJob.sourceTable}`;
  const sourceSchema = tableJob.sourceSchema ?? "dbo";
  const sourceTable = tableJob.sourceTable;
  const columns = tableJob.columns ?? [];
  const stagingTable = tableJob.stagingTable;
  const selectSqlFile = tableJob.selectSqlFile ?? null;
  const orderBy = tableJob.orderBy ?? "[PID]";
  const batchSize = Math.max(50, Math.min(5000, Number(tableJob.batchSize ?? migrationConfig.batchSize ?? 500)));
  const checkpointEnabled = migrationConfig.enableCheckpoint !== false;
  const checkpointDir = path.resolve(sqlBaseDir, migrationConfig.checkpointDir ?? "./checkpoints");
  fs.mkdirSync(checkpointDir, { recursive: true });
  const checkpointPath = path.join(checkpointDir, `${key}.json`);

  const isPatientInfoBuiltin = key === "patient_info" || (tableJob.sourceTable === "patient_info" && !tableJob.key);
  if (!sourceTable || !stagingTable || columns.length === 0) {
    throw new Error(`Table job '${key}' is incomplete`);
  }
  if (!selectSqlFile && !isPatientInfoBuiltin) {
    throw new Error(`Table job '${key}' is incomplete: set selectSqlFile or use key/sourceTable patient_info for built-in SELECT`);
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
    updatedAt: null
  });
  let offset = Number(tableJob.startOffset ?? (checkpointEnabled ? checkpoint.offset : 0));
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  console.error(`>>> [${key}] start offset: ${offset}`);

  if (isPatientInfoBuiltin && toArray(tableJob.preLoadSqlFiles).length === 0) {
    console.error(`>>> [${key}] ensure migrate_stg + norm_pid (built-in JS DDL)`);
    await ensurePatientInfoStagingDdl(pgClient);
  }
  for (const sqlFile of toArray(tableJob.preLoadSqlFiles)) {
    console.error(`>>> [${key}] run pre-load SQL: ${sqlFile}`);
    await pgClient.query(readSql(sqlBaseDir, sqlFile));
  }

  let total = 0;
  let sourceCases = 0;
  let patientSuccessCases = 0;
  let patientFailCases = 0;
  let addressSuccessCases = 0;
  const failedPidSet = new Set();
  const chunkResults = [];
  let chunkIndex = 0;

  while (true) {
    const r = await mssqlPool
      .request()
      .input("offset", sql.Int, offset)
      .input("page", sql.Int, batchSize)
      .query(selectSql);
    const rows = r.recordset || [];
    if (rows.length === 0) break;

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
      const unnestArgs = arrays.map((_, idx) => `$${idx + 1}::text[]`).join(", ");
      const insertStaging = `INSERT INTO ${stagingTable} (${columns.join(", ")}) SELECT * FROM unnest(${unnestArgs});`;
      await pgClient.query(insertStaging, arrays);

      if (toArray(tableJob.postLoadSqlFiles).length > 0) {
        for (const sqlFile of toArray(tableJob.postLoadSqlFiles)) {
          step = `run post-load SQL: ${sqlFile}`;
          console.error(`>>> [${key}] run post-load SQL: ${sqlFile}`);
          const postSql = stripTxWrappers(readSql(sqlBaseDir, sqlFile));
          await pgClient.query(postSql);
        }
      } else if (isPatientInfoBuiltin) {
        step = "run patient_info JS post-load (map -> public + address)";
        console.error(`>>> [${key}] runPatientInfoChunkPostLoad`);
        await runPatientInfoChunkPostLoad(pgClient, rows);
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
      chunkResults.push({
        chunkIndex,
        status: "failed",
        sourceOffsetStart,
        sourceOffsetEnd,
        rowCount: n,
        firstPid,
        lastPid,
        failedAtStep: step,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(
        `[${key}] failed chunk ${chunkIndex} (offset ${sourceOffsetStart}-${sourceOffsetEnd}, pid ${firstPid}..${lastPid}) at step '${step}': ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    total += n;
    offset += n;
    if (checkpointEnabled) {
      writeJson(checkpointPath, {
        key,
        offset,
        completed: false,
        updatedAt: new Date().toISOString()
      });
    }
    console.error(`... [${key}] processed ${total} rows (offset=${offset})`);
    if (rows.length < batchSize) break;
  }

  if (checkpointEnabled) {
    writeJson(checkpointPath, {
      key,
      offset,
      completed: true,
      updatedAt: new Date().toISOString()
    });
  }

  const summary = {
    key,
    totalRowsRead: total,
    source_cases: sourceCases,
    patient_success_cases: patientSuccessCases,
    patient_fail_cases: patientFailCases,
    address_success_cases: addressSuccessCases,
    failedPids: Array.from(failedPidSet),
    checkpointPath: checkpointEnabled ? checkpointPath : null,
    chunkCount: chunkIndex,
    chunkResults,
  };

  console.error(`>>> [${key}] done, total rows read: ${total}`);
  return summary;
}

async function main() {
  const configPath = path.resolve(process.cwd(), getConfigPath());
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const batchSize = Math.max(50, Math.min(5000, Number(config.migration?.batchSize ?? 500)));

  if (!config?.source) {
    throw new Error("Missing source config");
  }

  const mssqlConfig = buildMssqlConfig(config.source);
  if (!mssqlConfig.server || !mssqlConfig.database || !mssqlConfig.user) {
    throw new Error("source config is incomplete: require server/database/user (or mssqlUrl)");
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
    error: null
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
          migrationConfig: config.migration ?? {},
          tableJob
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
