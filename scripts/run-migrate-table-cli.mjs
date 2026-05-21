/**
 * npm run migrate:<profile> — ส่งต่อ argv หลัง -- ให้ migrate-from-mssql.mjs ครบ
 * (แก้กรณี Windows/npm ทำให้ --migrate-run-mode หาย เหลือแค่คำว่า overwrite)
 */
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

/** @type {Record<string, string>} */
const PROFILE_DIR = {
  patient_info: "patient-info",
  appointment: "appointment",
  examination: "examination",
  examination_general: "examination-general",
  pacs_sync_info: "pacs-sync-info",
  procedure: "procedure",
  ultrasound: "ultrasound",
  mam: "mam",
  mam_cal: "mam-cal",
  mam_mass: "mam-mass",
  ultrasound_cyst: "ultrasound-cyst",
  ultrasound_mass: "ultrasound-mass",
};

const profile = process.argv[2];
const forwarded = process.argv.slice(3);
const dir = profile ? PROFILE_DIR[profile] : null;

if (!dir) {
  console.error(
    [
      "Usage: node scripts/run-migrate-table-cli.mjs <profile> [args...]",
      "",
      "Profiles:",
      Object.keys(PROFILE_DIR).join(", "),
      "",
      "Example:",
      "  npm run migrate:patient_info -- --migrate-run-mode overwrite",
    ].join("\n"),
  );
  process.exit(1);
}

const jsMigrateDir = join(repoRoot, dir, "js-migrate");
const script = join(jsMigrateDir, "migrate-from-mssql.mjs");
const configPath = join(repoRoot, "migration.config.local.json");

const nodeArgs = [
  script,
  "--config",
  configPath,
  "--profile",
  profile,
  ...forwarded,
];

const r = spawnSync(process.execPath, nodeArgs, {
  stdio: "inherit",
  cwd: jsMigrateDir,
  env: process.env,
});

process.exit(r.status === null ? 1 : r.status);
