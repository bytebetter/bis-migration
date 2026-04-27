import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import pg from "pg";
import { MSSQL_APPOINTMENT_SELECT } from "./mssqlAppointmentSelect.mjs";
import { ensureAppointmentStagingDdl } from "./appointmentPgDdl.mjs";
import { runAppointmentChunkPostLoad } from "./appointmentMapping.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = "appointment";

const APPOINTMENT_COLUMNS = [
  "schedule_datetime",
  "schedule_number",
  "prefix",
  "name",
  "surname",
  "payment_type",
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
  return String(v).replace(/^\uFEFF/, "").trim();
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
  const checkpointPath = path.join(checkpointDir, `${key}.json`);
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

  const sourceSchema = source?.schema ?? "dbo";
  const sourceTable = source?.table ?? "schedule";
  const sourceObject = `${bracketIdent(sourceSchema)}.${bracketIdent(sourceTable)}`;
  const scheduleIdNumericOrderExpr =
    "CASE WHEN LTRIM(RTRIM([Schedule_ID])) <> '' AND LTRIM(RTRIM([Schedule_ID])) NOT LIKE '%[^0-9]%' THEN CONVERT(BIGINT, LTRIM(RTRIM([Schedule_ID]))) ELSE NULL END ASC, [Schedule_ID] ASC";
  const selectSql = MSSQL_APPOINTMENT_SELECT.replaceAll(
    "{{sourceObject}}",
    sourceObject,
  ).replaceAll("{{orderBy}}", scheduleIdNumericOrderExpr);

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
  if (sourceLimit != null) {
    console.error(
      `>>> [${key}] TEMP sourceLimit enabled: ${sourceLimit} records`,
    );
  }
  if (probeTiming) {
    console.error(`>>> [${key}] probeTiming enabled (MSSQL query latency logs)`);
  }

  console.error(`>>> [${key}] start offset: ${offset} (MSSQL OFFSET ตาม [Schedule_ID] order)`);
  await ensureAppointmentStagingDdl(pgClient);

  let total = 0;
  const chunkResults = [];
  let chunkIndex = 0;
  let successChunkCount = 0;
  let failedChunkCount = 0;

  while (true) {
    const chunkT0 = Date.now();
    const remaining = sourceLimit == null ? null : sourceLimit - total;
    if (remaining != null && remaining <= 0) break;
    const pageSize =
      remaining == null ? batchSize : Math.min(batchSize, remaining);
    const nextChunkIndex = chunkIndex + 1;
    console.error(
      `>>> [${key}] fetch chunk ${nextChunkIndex}: offset=${offset} pageSize=${pageSize}`,
    );

    const fetchStartedAt = Date.now();
    const r = await mssqlPool
      .request()
      .input("offset", sql.Int, offset)
      .input("page", sql.Int, pageSize)
      .query(selectSql);
    const fetchElapsedMs = Date.now() - fetchStartedAt;
    if (probeTiming) {
      console.error(
        `>>> [${key}] fetched rows: ${(r.recordset || []).length} (chunk ${nextChunkIndex}, mssql_query_ms=${fetchElapsedMs})`,
      );
    } else {
      console.error(
        `>>> [${key}] fetched rows: ${(r.recordset || []).length} (chunk ${nextChunkIndex})`,
      );
    }

    const rows = r.recordset || [];
    if (rows.length === 0) {
      console.error(
        `>>> [${key}] no more rows (mssql ${Date.now() - fetchStartedAt}ms); chunk wall ${Date.now() - chunkT0}ms`,
      );
      break;
    }

    const n = rows.length;
    chunkIndex += 1;
    const sourceOffsetStart = offset;
    const sourceOffsetEnd = offset + n - 1;
    const firstScheduleId = getScheduleIdForLog(rows[0]);
    const lastScheduleId = getScheduleIdForLog(rows[n - 1]);
    const arrays = APPOINTMENT_COLUMNS.map(() => new Array(n));
    for (let i = 0; i < n; i++) {
      rowToStagingArrays(rows[i], i, arrays, APPOINTMENT_COLUMNS);
    }

    let step = "begin chunk transaction";
    let lastChunkProcessMs = 0;
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
      await runAppointmentChunkPostLoad(pgClient, rows);
      await pgClient.query("COMMIT");
      lastChunkProcessMs = Date.now() - chunkT0;
      successChunkCount += 1;
      const chunkResult = {
        chunkIndex,
        status: "success",
        sourceOffsetStart,
        sourceOffsetEnd,
        rowCount: n,
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
      const chunkTotalMs = Date.now() - chunkT0;
      console.error(
        `>>> [${key}] chunk ${chunkIndex} failed after ${chunkTotalMs}ms (mssql_fetch ${fetchElapsedMs}ms) at step: ${step}`,
      );
      chunkResults.push({
        chunkIndex,
        status: "failed",
        sourceOffsetStart,
        sourceOffsetEnd,
        rowCount: n,
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

    total += n;
    offset += n;
    if (checkpointEnabled) {
      writeJson(checkpointPath, {
        key,
        offset,
        completed: false,
        updatedAt: new Date().toISOString(),
      });
    }
    const isLastPage = n < pageSize;
    console.error(
      `... [${key}] chunk ${chunkIndex} ok: ${n} rows, total ${total} (offset=${offset}) | chunk_ms=${lastChunkProcessMs} mssql_fetch_ms=${fetchElapsedMs}`,
    );
    for (let i = 0; i < arrays.length; i++) arrays[i].length = 0;
    rows.length = 0;
    if (isLastPage) break;
  }

  if (checkpointEnabled) {
    writeJson(checkpointPath, {
      key,
      offset,
      completed: true,
      updatedAt: new Date().toISOString(),
    });
  }

  const summary = {
    key,
    totalRowsRead: total,
    checkpointPath: checkpointEnabled ? checkpointPath : null,
    chunkCount: chunkIndex,
    successChunkCount,
    failedChunkCount,
    chunkLogMode,
    chunkSampleEvery,
    chunkResults,
  };
  console.error(`>>> [${key}] done, total rows read: ${total}`);
  return summary;
}

async function main() {
  const configPath = path.resolve(process.cwd(), getConfigPath());
  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const config = resolveRuntimeConfig(rawConfig, "appointment");

  const selectedProfile = getProfileName() ?? rawConfig.defaultProfile ?? "appointment";
  const batchFromProfile = rawConfig.profiles?.[selectedProfile]?.migration?.batchSize;
  const migrationForJob = {
    ...(config.migration ?? {}),
    batchSize:
      batchFromProfile != null && String(batchFromProfile).trim() !== ""
        ? Number(batchFromProfile)
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
