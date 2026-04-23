import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import pg from "pg";
import { MSSQL_EXAMINATION_SELECT } from "./mssqlExaminationSelect.mjs";
import {
  ensureExaminationOldExamIdIndex,
  ensureExaminationStagingDdl,
} from "./examinationPgDdl.mjs";
import {
  normExamId,
  runExaminationChunkPostLoad,
} from "./examinationMapping.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  return `${head},
  CAST([Exam_ID] AS BIGINT) AS __mssql_exam_id
FROM {{sourceObject}}
WHERE [Exam_ID] > @afterExamId
ORDER BY [Exam_ID] ASC
OFFSET 0 ROWS FETCH NEXT @page ROWS ONLY;`;
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
  return [
    {
      key: "examination",
      sourceSchema: config.source?.schema ?? "dbo",
      sourceTable: config.source?.table ?? "examination",
      orderBy: "[Exam_ID]",
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
  const checkpointPath = path.join(checkpointDir, `${key}.json`);
  const isExaminationBuiltin =
    key === "examination" || tableJob.sourceTable === "examination";

  if (!sourceTable || !stagingTable || columns.length === 0) {
    throw new Error(`Table job '${key}' is incomplete`);
  }
  if (!selectSqlFile && !isExaminationBuiltin) {
    throw new Error(
      `Table job '${key}' is incomplete: set selectSqlFile or use key/sourceTable examination for built-in SELECT`,
    );
  }

  const sourceObject = `${bracketIdent(sourceSchema)}.${bracketIdent(sourceTable)}`;
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

  const selectSql = (() => {
    const tpl = selectSqlFile
      ? readSql(sqlBaseDir, selectSqlFile)
      : useMssqlKeyset
        ? buildMssqlExaminationKeysetSelect()
        : MSSQL_EXAMINATION_SELECT;
    return tpl
      .replaceAll("{{sourceObject}}", sourceObject)
      .replaceAll("{{orderBy}}", orderBy);
  })();

  let mssqlKeysetAfter = checkpoint.mssqlKeysetAfter;
  if (useMssqlKeyset && mssqlKeysetAfter == null) mssqlKeysetAfter = -1;
  if (!useMssqlKeyset) mssqlKeysetAfter = null;

  console.error(
    `>>> [${key}] start offset: ${offset}${useMssqlKeyset ? " (MSSQL keyset ตาม [Exam_ID])" : ""}`,
  );

  if (isExaminationBuiltin && toArray(tableJob.preLoadSqlFiles).length === 0) {
    console.error(
      `>>> [${key}] ensure migrate_stg + norm functions (built-in JS DDL)`,
    );
    await ensureExaminationStagingDdl(pgClient);
    await ensureExaminationOldExamIdIndex(pgClient);
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
  const chunkResults = [];
  let chunkIndex = 0;

  while (true) {
    const r = useMssqlKeyset
      ? await mssqlPool
          .request()
          .input("afterExamId", sql.BigInt, toBigIntish(mssqlKeysetAfter))
          .input("page", sql.Int, batchSize)
          .query(selectSql)
      : await mssqlPool
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
    const firstExamId = normExamId(rows[0]?.exam_id);
    const lastExamId = normExamId(rows[n - 1]?.exam_id);
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
          console.error(`>>> [${key}] run post-load SQL: ${sqlFile}`);
          const postSql = stripTxWrappers(readSql(sqlBaseDir, sqlFile));
          await pgClient.query(postSql);
        }
      } else if (isExaminationBuiltin) {
        step = "run examination JS post-load (map -> public.examination)";
        console.error(`>>> [${key}] runExaminationChunkPostLoad`);
        await runExaminationChunkPostLoad(pgClient, rows);
      }

      step = "compute chunk stats";
      const stats = await pgClient.query(`
WITH src AS (
  SELECT DISTINCT migrate_stg.norm_exam_id(exam_id) AS nexam
  FROM migrate_stg.examination_mssql
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
  FROM migrate_stg.examination_mssql
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

      await pgClient.query("COMMIT");
      chunkResults.push({
        chunkIndex,
        status: "success",
        sourceOffsetStart,
        sourceOffsetEnd,
        rowCount: n,
        firstExamId,
        lastExamId,
        source_cases: Number(chunkStats.source_cases ?? 0),
        examination_success_cases: Number(
          chunkStats.examination_success_cases ?? 0,
        ),
        examination_fail_cases: Number(chunkStats.examination_fail_cases ?? 0),
      });
    } catch (err) {
      await pgClient.query("ROLLBACK");
      chunkResults.push({
        chunkIndex,
        status: "failed",
        sourceOffsetStart,
        sourceOffsetEnd,
        rowCount: n,
        firstExamId,
        lastExamId,
        failedAtStep: step,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(
        `[${key}] failed chunk ${chunkIndex} (offset ${sourceOffsetStart}-${sourceOffsetEnd}, exam_id ${firstExamId}..${lastExamId}) at step '${step}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    total += n;
    offset += n;
    if (useMssqlKeyset) {
      const lastId = rows[n - 1].__mssql_exam_id;
      mssqlKeysetAfter = lastId;
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
    console.error(`... [${key}] processed ${total} rows (offset=${offset})`);
    if (rows.length < batchSize) break;
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
  FROM migrate_stg.examination_mssql s
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

  const summary = {
    key,
    totalRowsRead: total,
    source_cases: sourceCases,
    examination_success_cases: examinationSuccessCases,
    examination_fail_cases: examinationFailCases,
    failedExamIds: Array.from(failedExamIdSet),
    missingByReason: missingByReason.rows,
    checkpointPath: checkpointEnabled ? checkpointPath : null,
    chunkCount: chunkIndex,
    chunkResults,
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
          migrationConfig: config.migration ?? {},
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
