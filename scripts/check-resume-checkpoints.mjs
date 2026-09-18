/**
 * migrate:all (resume) เรียกก่อนเริ่มทุกรอบ — ให้ checkpoint กับข้อมูลปลายทางไปด้วยกันเสมอ (อ่าน Postgres อย่างเดียว)
 * - ตารางปลายทางว่าง แต่มี checkpoint (ล้างข้อมูลแล้วยังไม่ลบ checkpoint)
 *     → ย้าย checkpoint ไปเป็น .bak-<เวลา> ตารางนั้นเริ่มอ่านใหม่ทั้งตาราง
 * - ตารางปลายทางมีข้อมูล แต่ไม่มี checkpoint (ลบ checkpoint / รอบก่อนรันแบบ overwrite)
 *     → หยุดทั้งรอบ: ถ้ารันต่อจะอ่านทั้งตารางใหม่ = log insert ซ้ำ, แถวที่แก้ในระบบใหม่ถูกเขียนทับ, ช้า
 *
 * Usage: node scripts/check-resume-checkpoints.mjs --config <path> [--tables patient_info,appointment,...]
 * exit 1 เมื่อพบตารางที่มีข้อมูลแต่ไม่มี checkpoint
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { resolveRuntimeConfig } from "../shared/js-migrate/resolveMigrationConfig.mjs";
import {
  RESUME_CHECKPOINT_TABLES,
  alignResumeCheckpointsWithTarget,
} from "./migrateResumeTables.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const configPath = path.resolve(
    argValue("--config") ?? path.join(repoRoot, "migration.config.local.json"),
  );
  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const tablesArg = argValue("--tables");
  const profiles = (tablesArg ? tablesArg.split(",") : Object.keys(RESUME_CHECKPOINT_TABLES))
    .map((s) => s.trim())
    .filter((p) => RESUME_CHECKPOINT_TABLES[p]);
  const profileConfig = (profile) =>
    resolveRuntimeConfig(
      { ...rawConfig, profiles: { [profile]: {}, ...rawConfig.profiles } },
      profile,
    );

  const target = profileConfig("patient_info").target;
  const client = new pg.Client({
    host: target.postgresHost,
    port: Number(target.postgresPort ?? 5432),
    user: target.postgresUser,
    password: target.postgresPassword,
    database: target.postgresDatabase,
  });
  await client.connect();
  let result;
  try {
    result = await alignResumeCheckpointsWithTarget({
      client,
      repoRoot,
      profiles,
      checkpointDirOf: (p) => profileConfig(p).migration?.checkpointDir,
      stamp: new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-"),
      log: (msg) => console.log(msg),
    });
  } finally {
    await client.end();
  }

  if (result.missing.length > 0) {
    console.error(">>> [checkpoint] หยุด: ตารางปลายทางมีข้อมูลแต่ไม่มี checkpoint");
    for (const m of result.missing) {
      console.error(`    - ${m.profile}: public.${m.target} (ไม่พบ ${path.relative(repoRoot, m.file)})`);
    }
    console.error(
      "    ถ้ารันต่อจะอ่านทั้งตารางใหม่ (log insert ซ้ำ / เขียนทับแถวที่แก้ในระบบใหม่) — " +
        "กู้ไฟล์ checkpoint กลับมา หรือถ้าตั้งใจเริ่มใหม่ให้ล้างตารางปลายทางนั้นก่อน",
    );
    process.exit(1);
  }
  console.log(`>>> [checkpoint] ตรวจแล้ว ${profiles.length} ตาราง — checkpoint ตรงกับข้อมูลปลายทาง`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
