/**
 * เทียบจำนวน MSSQL vs Postgres + keyset walk + แถวที่เคยหาย (rn 500001)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import pg from "pg";
import {
  MSSQL_APPOINTMENT_RESCHEDULE_ACTIVITY,
  MSSQL_RESCHEDULE_LOGTIME_ORDER_EXPR,
  MSSQL_RESCHEDULE_MODIFIED_ORDER_EXPR,
  MSSQL_RESCHEDULE_OLD_SCHEDULE_DT_ORDER_EXPR,
  MSSQL_RESCHEDULE_SCHEDULE_DT_ORDER_EXPR,
  MSSQL_RESCHEDULE_SCHEDULE_ID_ORDER_EXPR,
} from "./mssqlAppointmentReschedulesSelect.mjs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const configPath = path.resolve(__dirname, "../../migration.config.local.json");
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const shared = raw.shared ?? {};
  const profile = raw.profiles?.appointment_reschedules ?? {};
  return {
    source: { ...(shared.source ?? {}), ...(profile.source ?? {}) },
    target: { ...(shared.target ?? {}), ...(profile.target ?? {}) },
    batchSize: profile.migration?.batchSize ?? 10000,
  };
}

function buildMssqlConfig(sourceConfig) {
  return {
    server: sourceConfig.server,
    port: Number(sourceConfig.port ?? 1433),
    database: sourceConfig.database,
    user: sourceConfig.user,
    password: sourceConfig.password,
    options: {
      encrypt: sourceConfig.encrypt !== false,
      trustServerCertificate: sourceConfig.trustServerCertificate !== false,
      requestTimeout: 0,
    },
    pool: { max: 2, min: 0 },
  };
}

function buildPgConfig(target) {
  return {
    host: target.postgresHost ?? "127.0.0.1",
    port: Number(target.postgresPort ?? 5432),
    user: target.postgresUser,
    password: target.postgresPassword,
    database: target.postgresDatabase,
  };
}

async function countMssql(pool) {
  const r = await pool.request().query(`
    SELECT COUNT_BIG(1) AS total
    FROM [dbo].[SCHEDULE_LOG]
    WHERE [Activity] = N'${MSSQL_APPOINTMENT_RESCHEDULE_ACTIVITY}'
  `);
  return Number(r.recordset[0]?.total ?? 0);
}

async function countPostgres(client) {
  const r = await client.query(
    "SELECT COUNT(*)::bigint AS total FROM public.appointment_reschedules",
  );
  return Number(r.rows[0]?.total ?? 0);
}

/** แถวที่เคยถูก keyset ข้าม (ก่อนเพิ่ม Old_Schedule_Datetime ใน cursor) */
async function fetchPreviouslyMissingRow(pool) {
  const r = await pool.request().query(`
    SELECT TOP (1)
      [LogTime], [Schedule_ID], [Schedule_Datetime], [ModifiedDate], [Old_Schedule_Datetime]
    FROM [dbo].[SCHEDULE_LOG]
    WHERE [Activity] = N'${MSSQL_APPOINTMENT_RESCHEDULE_ACTIVITY}'
      AND [LogTime] IS NULL
      AND [Schedule_ID] IS NULL
      AND [Schedule_Datetime] = '2006-01-31 13:00:00'
      AND [ModifiedDate] IS NULL
      AND [Old_Schedule_Datetime] = '2005-12-30 10:00:00'
  `);
  return r.recordset[0] ?? null;
}

/** แถวในกลุ่ม 4-key เดียวกับแถวที่เคยหาย (ไม่มี LogTime/Schedule_ID/ModifiedDate) */
async function countFourKeyGroupMssql(pool) {
  const r = await pool.request().query(`
    SELECT COUNT_BIG(1) AS n
    FROM [dbo].[SCHEDULE_LOG]
    WHERE [Activity] = N'${MSSQL_APPOINTMENT_RESCHEDULE_ACTIVITY}'
      AND [LogTime] IS NULL
      AND [Schedule_ID] IS NULL
      AND [Schedule_Datetime] = '2006-01-31 13:00:00'
      AND [ModifiedDate] IS NULL
  `);
  return Number(r.recordset[0]?.n ?? 0);
}

async function countSameDatetimePostgres(client) {
  const r = await client.query(`
    SELECT COUNT(*)::int AS n
    FROM public.appointment_reschedules
    WHERE appointment_datetime = '2006-01-31 13:00:00'
       OR appointment_datetime = '2006-01-31 06:00:00+00'
  `);
  return Number(r.rows[0]?.n ?? 0);
}

async function countKeysetSkippedCandidates(pool, batchSize) {
  const orderBy = `${MSSQL_RESCHEDULE_LOGTIME_ORDER_EXPR} DESC, ${MSSQL_RESCHEDULE_SCHEDULE_ID_ORDER_EXPR} DESC, ${MSSQL_RESCHEDULE_SCHEDULE_DT_ORDER_EXPR} DESC, ${MSSQL_RESCHEDULE_MODIFIED_ORDER_EXPR} DESC, ${MSSQL_RESCHEDULE_OLD_SCHEDULE_DT_ORDER_EXPR} DESC`;
  const r = await pool
    .request()
    .input("batch", sql.Int, batchSize)
    .query(`
WITH ordered AS (
  SELECT
    ROW_NUMBER() OVER (ORDER BY ${orderBy}) AS rn,
    ${MSSQL_RESCHEDULE_LOGTIME_ORDER_EXPR} AS k_log_time,
    ${MSSQL_RESCHEDULE_SCHEDULE_ID_ORDER_EXPR} AS k_schedule_id,
    ${MSSQL_RESCHEDULE_SCHEDULE_DT_ORDER_EXPR} AS k_schedule_dt,
    ${MSSQL_RESCHEDULE_MODIFIED_ORDER_EXPR} AS k_modified,
    ${MSSQL_RESCHEDULE_OLD_SCHEDULE_DT_ORDER_EXPR} AS k_old_schedule_dt
  FROM [dbo].[SCHEDULE_LOG]
  WHERE [Activity] = N'${MSSQL_APPOINTMENT_RESCHEDULE_ACTIVITY}'
),
boundary AS (
  SELECT rn, k_log_time, k_schedule_id, k_schedule_dt, k_modified, k_old_schedule_dt
  FROM ordered WHERE rn % @batch = 0
)
SELECT COUNT_BIG(1) AS skipped
FROM ordered o
INNER JOIN boundary b
  ON o.k_log_time = b.k_log_time
 AND o.k_schedule_id = b.k_schedule_id
 AND o.k_schedule_dt = b.k_schedule_dt
 AND o.k_modified = b.k_modified
 AND o.k_old_schedule_dt = b.k_old_schedule_dt
WHERE o.rn > b.rn;
`);
  return Number(r.recordset[0]?.skipped ?? 0);
}

async function main() {
  const cfg = loadConfig();
  const batchSize = cfg.batchSize;

  const mssqlPool = await sql.connect(buildMssqlConfig(cfg.source));
  const pgClient = new pg.Client(buildPgConfig(cfg.target));
  await pgClient.connect();

  try {
    const [
      mssqlCount,
      pgCount,
      skippedCandidates,
      prevMissing,
      fourKeyGroupMssql,
      fourKeyGroupPg,
    ] = await Promise.all([
      countMssql(mssqlPool),
      countPostgres(pgClient),
      countKeysetSkippedCandidates(mssqlPool, batchSize),
      fetchPreviouslyMissingRow(mssqlPool),
      countFourKeyGroupMssql(mssqlPool),
      countSameDatetimePostgres(pgClient),
    ]);

    const checkpointPath = path.join(
      __dirname,
      "checkpoints/appointment_reschedules.json",
    );
    let checkpoint = null;
    if (fs.existsSync(checkpointPath)) {
      checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
    }

    const logsDir = path.join(__dirname, "logs");
    const migrateLogs = fs
      .readdirSync(logsDir)
      .filter((f) => f.startsWith("migrate-") && f.endsWith(".json"))
      .sort()
      .reverse();
    let lastMigrate = null;
    if (migrateLogs[0]) {
      lastMigrate = JSON.parse(
        fs.readFileSync(path.join(logsDir, migrateLogs[0]), "utf8"),
      );
    }
    const lastTable = lastMigrate?.tableResults?.[0];

    console.log("=== สรุปเทียบ MSSQL ↔ Postgres (appointment_reschedules) ===\n");
    console.log(`MSSQL (Activity=ย้ายวันนัด):     ${mssqlCount}`);
    console.log(`Postgres (appointment_reschedules): ${pgCount}`);
    console.log(
      `ต่างกัน: ${mssqlCount - pgCount} (${mssqlCount === pgCount ? "เท่ากัน ✓" : "ไม่เท่ากัน ✗"})`,
    );
    console.log(`\nKeyset อาจข้าม (5 มิติ, batch ${batchSize}): ${skippedCandidates}`);
    console.log(
      `แถวที่เคยหาย (MSSQL ยังมี): ${prevMissing ? "พบ ✓" : "ไม่พบ"}`,
    );
    console.log(
      `กลุ่ม 4-key ซ้ำ (NULL LogTime + 2006-01-31 13:00): MSSQL=${fourKeyGroupMssql}, Postgres (appointment_datetime เดียวกัน)=${fourKeyGroupPg} ${fourKeyGroupMssql === fourKeyGroupPg ? "✓" : "✗"}`,
    );

    if (checkpoint) {
      console.log(
        `\nCheckpoint: offset=${checkpoint.offset}, completed=${checkpoint.completed}, oldScheduleDatetime ใน keyset=${checkpoint.mssqlKeysetAfter?.oldScheduleDatetime != null ? "มี ✓" : "ไม่มี ✗"}`,
      );
    }

    if (lastTable) {
      console.log(
        `\nMigrate ล่าสุด (${migrateLogs[0]}): read=${lastTable.totalRowsRead}, written=${lastTable.totalRowsWritten}, chunks ok=${lastTable.successChunkCount}/${lastTable.chunkCount}`,
      );
    }

    const ok =
      mssqlCount === pgCount &&
      mssqlCount > 0 &&
      skippedCandidates === 0 &&
      (checkpoint?.offset ?? 0) === mssqlCount &&
      checkpoint?.completed === true &&
      lastTable?.totalRowsRead === mssqlCount &&
      lastTable?.totalRowsWritten === mssqlCount &&
      prevMissing != null &&
      fourKeyGroupMssql === fourKeyGroupPg;

    console.log(
      `\n=== ผลรวม: ${ok ? "ครบและสอดคล้อง ✓" : "ยังไม่ครบหรือมีจุดที่ต้องตรวจ ✗"} ===`,
    );
    if (!ok) {
      if (mssqlCount !== pgCount) {
        console.log("  - จำนวนแถว MSSQL กับ Postgres ไม่เท่ากัน");
      }
      if (skippedCandidates > 0) {
        console.log(
          "  - ยังมีแถวที่ keyset อาจข้าม — ตรวจ ORDER BY / cursor ใน mssqlAppointmentReschedulesSelect.mjs แล้ว migrate ใหม่",
        );
      }
      if (fourKeyGroupMssql !== fourKeyGroupPg) {
        console.log(
          "  - จำนวนในกลุ่ม datetime 2006-01-31 13:00 ไม่ตรง (Postgres ไม่เก็บ Old_Schedule_Datetime — ใช้เป็น spot-check)",
        );
      }
      if (lastTable && lastTable.totalRowsRead !== mssqlCount) {
        console.log("  - migrate ล่าสุดอ่านไม่ครบ COUNT");
      }
    }

    process.exitCode = ok ? 0 : 1;
  } finally {
    await pgClient.end();
    await mssqlPool.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
