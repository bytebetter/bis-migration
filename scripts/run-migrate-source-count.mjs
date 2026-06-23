/**
 * นับจำนวนแถวต้นทาง MSSQL สำหรับ migrate:all snapshot
 * — ใช้ node_modules ที่ repo root เท่านั้น (ไม่ต้อง Postgres / migrate เต็ม)
 *
 * Usage:
 *   node scripts/run-migrate-source-count.mjs --config ./migration.config.local.json --profile ultrasound
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import { buildMssqlConfig } from "../shared/js-migrate/mssqlConnectConfig.mjs";
import { buildMigrateSourceCountSql } from "../shared/js-migrate/migrateSourceCountSql.mjs";
import {
  readProfileFromArgv,
  resolveMssqlSourceObject,
  resolveRuntimeConfig,
} from "../shared/js-migrate/resolveMigrationConfig.mjs";
import {
  emitSourceCountAndExit,
  isCountOnlyRun,
} from "../shared/js-migrate/sourceCountSnapshot.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

async function main() {
  if (!isCountOnlyRun()) {
    console.error("run-migrate-source-count.mjs requires --count-only");
    process.exit(2);
  }

  const profile = readProfileFromArgv();
  if (!profile) {
    console.error("missing --profile");
    process.exit(2);
  }

  const configArg = process.argv.includes("--config")
    ? path.resolve(String(process.argv[process.argv.indexOf("--config") + 1]))
    : path.join(repoRoot, "migration.config.local.json");

  const rawConfig = JSON.parse(fs.readFileSync(configArg, "utf8"));
  const config = resolveRuntimeConfig(rawConfig, profile);
  if (!config?.source) {
    console.error(`missing source config for profile ${profile}`);
    process.exit(2);
  }

  const { schema, table } = resolveMssqlSourceObject(profile, config.source);
  const countSql = buildMigrateSourceCountSql(profile, schema, table);

  const pool = await sql.connect(buildMssqlConfig(config.source));
  try {
    const countRes = await pool.request().query(countSql);
    const total = Number(countRes.recordset?.[0]?.total ?? 0);
    emitSourceCountAndExit(total);
  } catch (err) {
    console.error(
      `>>> [${profile}] source count failed (${schema}.${table}):`,
      err instanceof Error ? err.message : err,
    );
    emitSourceCountAndExit(null);
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
