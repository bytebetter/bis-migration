/**
 * ปลด lock / connection ค้างบน public.patient_info (ไม่ต้องติดตั้ง psql)
 *
 * Usage:
 *   node scripts/fix-pg-patient-info-locks.mjs              # ดูอย่างเดียว (dry-run)
 *   node scripts/fix-pg-patient-info-locks.mjs --apply      # terminate connection ที่ปลอดภัย
 *   node scripts/fix-pg-patient-info-locks.mjs --apply --pid 1647501
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function getConfigPath() {
  const idx = process.argv.indexOf("--config");
  if (idx >= 0 && process.argv[idx + 1]) {
    return path.resolve(String(process.argv[idx + 1]));
  }
  return path.join(repoRoot, "migration.config.local.json");
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function readPidArg() {
  const idx = process.argv.indexOf("--pid");
  if (idx >= 0 && process.argv[idx + 1]) {
    const n = Number.parseInt(String(process.argv[idx + 1]), 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function main() {
  const apply = hasFlag("--apply");
  const onlyPid = readPidArg();
  const configPath = getConfigPath();
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const target = raw?.shared?.target ?? raw?.target;
  if (!target) {
    console.error("missing target in config");
    process.exit(2);
  }

  const pool = new pg.Pool({
    host: target.postgresHost,
    port: Number(target.postgresPort ?? 5432),
    user: target.postgresUser,
    password: target.postgresPassword,
    database: target.postgresDatabase ?? "bisinfo",
    max: 2,
    connectionTimeoutMillis: 15_000,
  });

  const client = await pool.connect();
  try {
    console.log(`\n=== fix patient_info locks (${apply ? "APPLY" : "dry-run"}) ===`);
    console.log(
      `Postgres: ${target.postgresUser}@${target.postgresHost}:${target.postgresPort ?? 5432}/${target.postgresDatabase ?? "bisinfo"}\n`,
    );

    const locks = await client.query(`
      SELECT l.pid, l.mode, a.state, a.wait_event_type, a.wait_event,
             a.application_name, left(a.query, 100) AS query
      FROM pg_locks l
      JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.relation = 'public.patient_info'::regclass
        AND a.pid <> pg_backend_pid()
      ORDER BY l.mode DESC, l.pid
    `);

    if (locks.rows.length === 0) {
      console.log("ไม่พบ lock จาก process อื่นบน patient_info — พร้อม migrate ได้");
      return;
    }

    console.log(`พบ ${locks.rows.length} lock:`);
    for (const row of locks.rows) {
      console.log(
        `  pid=${row.pid} mode=${row.mode} state=${row.state} app=${row.application_name ?? "-"}`,
      );
      if (row.query) console.log(`    query: ${row.query}`);
    }

    /** @type {number[]} */
    let pidsToKill = [];
    if (onlyPid != null) {
      pidsToKill = [onlyPid];
    } else {
      const idle = await client.query(`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND state = 'idle in transaction'
      `);
      const waiters = await client.query(`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%patient_info%'
      `);
      pidsToKill = [
        ...new Set([
          ...idle.rows.map((r) => Number(r.pid)),
          ...waiters.rows.map((r) => Number(r.pid)),
        ]),
      ];
    }

    if (pidsToKill.length === 0) {
      console.log("\nไม่มี pid ที่เข้าเกณฑ์ terminate อัตโนมัติ — ระบุ --pid <n> --apply");
      return;
    }

    console.log(`\nจะ terminate: ${pidsToKill.join(", ")}`);
    if (!apply) {
      console.log("\n(dry-run) รันซ้ำด้วย --apply เพื่อ terminate จริง");
      return;
    }

    for (const pid of pidsToKill) {
      const r = await client.query("SELECT pg_terminate_backend($1) AS ok", [pid]);
      const ok = r.rows[0]?.ok === true;
      console.log(`  terminate ${pid}: ${ok ? "OK" : "FAILED"}`);
    }

    const left = await client.query(`
      SELECT count(*)::int AS n FROM pg_locks
      WHERE relation = 'public.patient_info'::regclass
    `);
    console.log(`\nlock เหลือบน patient_info: ${left.rows[0]?.n ?? "?"}`);
    console.log("ต่อไป: node scripts/diagnose-migrate-env.mjs");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
