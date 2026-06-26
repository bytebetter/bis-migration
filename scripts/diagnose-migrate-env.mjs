/**
 * ตรวจสภาพแวดล้อม migrate — MSSQL, Postgres, lock บน patient_info
 *
 * Usage:
 *   node scripts/diagnose-migrate-env.mjs
 *   node scripts/diagnose-migrate-env.mjs --config ./migration.config.local.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import pg from "pg";
import { buildMssqlConfig } from "../shared/js-migrate/mssqlConnectConfig.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function getConfigPath() {
  const idx = process.argv.indexOf("--config");
  if (idx >= 0 && process.argv[idx + 1]) {
    return path.resolve(String(process.argv[idx + 1]));
  }
  return path.join(repoRoot, "migration.config.local.json");
}

function msSince(t0) {
  return `${((Date.now() - t0) / 1000).toFixed(2)}s`;
}

async function timed(label, fn) {
  const t0 = Date.now();
  process.stdout.write(`  ${label}… `);
  try {
    const result = await fn();
    console.log(`OK (${msSince(t0)})`);
    return { ok: true, result, ms: Date.now() - t0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`FAIL (${msSince(t0)}) — ${msg}`);
    return { ok: false, error: msg, ms: Date.now() - t0 };
  }
}

async function main() {
  const configPath = getConfigPath();
  console.log(`\n=== BIS migrate environment diagnose ===`);
  console.log(`Config: ${configPath}\n`);

  if (!fs.existsSync(configPath)) {
    console.error("Config file not found");
    process.exit(2);
  }

  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const source = raw?.shared?.source ?? raw?.source;
  const target = raw?.shared?.target ?? raw?.target;

  if (!source || !target) {
    console.error("Missing shared.source or shared.target in config");
    process.exit(2);
  }

  // ── MSSQL ─────────────────────────────────────────────────────────────
  console.log("── MSSQL (source) ──");
  console.log(`  server: ${source.server}:${source.port ?? 1433}`);
  console.log(`  database: ${source.database}`);

  const mssqlCfg = buildMssqlConfig(source);
  mssqlCfg.options = {
    ...mssqlCfg.options,
    requestTimeout: 30_000,
    connectTimeout: 15_000,
  };

  const mssql = await timed("connect", () => sql.connect(mssqlCfg));
  if (mssql.ok) {
    const pool = mssql.result;
    try {
      const ping = await timed("SELECT 1", async () => {
        const r = await pool.request().query("SELECT 1 AS ok");
        return r.recordset?.[0]?.ok;
      });
      const cnt = await timed("COUNT dbo.patient_info", async () => {
        const r = await pool.request().query(
          "SELECT COUNT_BIG(1) AS n FROM dbo.patient_info",
        );
        return Number(r.recordset?.[0]?.n ?? 0);
      });
      if (cnt.ok) console.log(`  patient_info rows (MSSQL): ${cnt.result}`);
      if (!ping.ok || !cnt.ok) {
        console.log("\n⚠ MSSQL มีปัญหา — migrate จะค้าง/ล้มเหลวทุกตารางที่อ่านจาก MSSQL");
      }
    } finally {
      await pool.close();
    }
  } else {
    console.log("\n⚠ ไม่ต่อ MSSQL ได้ — ตรวจ server/network (fly.dev)");
  }

  // ── Postgres ────────────────────────────────────────────────────────────
  console.log("\n── Postgres (target) ──");
  console.log(`  host: ${target.postgresHost}:${target.postgresPort ?? 5432}`);
  console.log(`  database: ${target.postgresDatabase ?? "bisinfo_dev_clone"}`);

  const pgPool = new pg.Pool({
    host: target.postgresHost,
    port: Number(target.postgresPort ?? 5432),
    user: target.postgresUser,
    password: target.postgresPassword,
    database: target.postgresDatabase ?? "bisinfo_dev_clone",
    max: 2,
    connectionTimeoutMillis: 15_000,
  });

  let pgClient;
  try {
    const conn = await timed("connect", () => pgPool.connect());
    if (!conn.ok) {
      console.log("\n⚠ ไม่ต่อ Postgres ได้ — ตรวจว่า postgres รันอยู่ที่ 127.0.0.1");
      return;
    }
    pgClient = conn.result;

    await timed("SET statement_timeout 15s", () =>
      pgClient.query("SET statement_timeout = '15s'"),
    );

    const cnt = await timed("COUNT public.patient_info", async () => {
      const r = await pgClient.query(
        "SELECT COUNT(1)::bigint AS n FROM public.patient_info",
      );
      return Number(r.rows[0]?.n ?? 0);
    });
    if (cnt.ok) console.log(`  patient_info rows (Postgres): ${cnt.result}`);
    else if (/timeout|canceling statement/i.test(cnt.error ?? "")) {
      console.log(
        "\n⚠ Postgres COUNT ค้าง/timeout — น่าจะมี LOCK บน patient_info จาก connection ค้าง",
      );
    }

    const locks = await timed("pg_locks on patient_info", async () => {
      const r = await pgClient.query(`
        SELECT l.pid, l.mode, a.state, a.wait_event_type, a.wait_event,
               left(a.query, 100) AS query
        FROM pg_locks l
        JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.relation = 'public.patient_info'::regclass
          AND a.pid <> pg_backend_pid()
      `);
      return r.rows;
    });
    if (locks.ok && locks.result.length > 0) {
      console.log(`\n  ⚠ พบ ${locks.result.length} lock บน patient_info:`);
      for (const row of locks.result) {
        console.log(
          `    pid=${row.pid} mode=${row.mode} state=${row.state} wait=${row.wait_event_type}/${row.wait_event}`,
        );
        if (row.query) console.log(`      query: ${row.query}`);
      }
      console.log(
        "\n  แก้: SELECT pg_terminate_backend(<pid>); สำหรับ connection ที่ idle in transaction",
      );
    } else if (locks.ok) {
      console.log("  ไม่พบ lock จาก process อื่นบน patient_info");
    }

    const idle = await timed("idle in transaction", async () => {
      const r = await pgClient.query(`
        SELECT pid, state, left(query, 80) AS query,
               now() - state_change AS idle_for
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND state = 'idle in transaction'
      `);
      return r.rows;
    });
    if (idle.ok && idle.result.length > 0) {
      console.log(`\n  ⚠ พบ ${idle.result.length} connection 'idle in transaction':`);
      for (const row of idle.result) {
        console.log(`    pid=${row.pid} idle_for=${row.idle_for} query=${row.query}`);
      }
    }

    await pgClient.query("RESET statement_timeout");
  } finally {
    pgClient?.release();
    await pgPool.end();
  }

  // ── Checkpoint ──────────────────────────────────────────────────────────
  console.log("\n── patient_info checkpoint ──");
  const ckPath = path.join(
    repoRoot,
    "patient-info/js-migrate/checkpoints/patient_info.json",
  );
  if (fs.existsSync(ckPath)) {
    const ck = JSON.parse(fs.readFileSync(ckPath, "utf8"));
    console.log(`  completed: ${ck.completed}`);
    console.log(`  offset: ${ck.offset}`);
    console.log(`  sourceRowCount: ${ck.sourceRowCount ?? "(n/a)"}`);
    console.log(`  updatedAt: ${ck.updatedAt ?? "(n/a)"}`);
  } else {
    console.log(`  (ไม่มีไฟล์ ${ckPath})`);
  }

  console.log("\n── สรุป ──");
  console.log(
    "migrate:all รันทีละตาราง — ถ้า patient_info (ตารางที่ 1) ค้าง ตารางอื่นจะไม่เริ่ม",
  );
  console.log(
    "ทดสอบตารางอื่นโดยไม่ผ่าน patient_info: npm run migrate:all -- -StartFrom 2 -Tables appointment",
  );
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
