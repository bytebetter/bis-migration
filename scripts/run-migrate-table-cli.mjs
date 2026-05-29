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
  appointment_reschedules: "appointment-reschedules",
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
const forwarded = normalizeForwardedArgs(process.argv.slice(3));
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

/**
 * แก้เคส npm/Windows กลืนชื่อ flag เหลือแต่ value เช่น "1-100"
 * รองรับเฉพาะ source-index-range/source-index-from/source-index-to
 * @param {string[]} args
 * @returns {string[]}
 */
function normalizeForwardedArgs(args) {
  const out = [];
  let hasSourceIndexRangeFlag = false;
  let hasSourceIndexFrom = false;
  let hasSourceIndexTo = false;
  const rangeValueRe = /^-?\d+\s*-\s*(-?\d+|all)?$/i;
  const singleValueRe = /^(all|\*|-?\d+)$/i;

  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    const a = String(raw ?? "").trim();
    const low = a.toLowerCase();
    if (!a) continue;
    if (low === "--source-index-range") {
      hasSourceIndexRangeFlag = true;
      out.push(a);
      const next = args[i + 1];
      if (next != null) {
        out.push(String(next));
        i++;
      }
      continue;
    }
    if (low === "--source-index-from") {
      hasSourceIndexFrom = true;
      out.push(a);
      const next = args[i + 1];
      if (next != null) {
        out.push(String(next));
        i++;
      }
      continue;
    }
    if (low === "--source-index-to") {
      hasSourceIndexTo = true;
      out.push(a);
      const next = args[i + 1];
      if (next != null) {
        out.push(String(next));
        i++;
      }
      continue;
    }
    out.push(a);
  }

  if (
    !hasSourceIndexRangeFlag &&
    !hasSourceIndexFrom &&
    !hasSourceIndexTo &&
    out.length > 0
  ) {
    const eligible = out.filter((x) => !x.startsWith("-"));
    if (
      eligible.length === 1 &&
      (rangeValueRe.test(eligible[0]) || singleValueRe.test(eligible[0]))
    ) {
      const envIndexRangeFlagOnly = hasEnvFlag("npm_config_source_index_range");
      const envIndexRange = readEnvArg("npm_config_source_index_range");
      if (envIndexRange) return ["--source-index-range", envIndexRange];
      if (envIndexRangeFlagOnly) return ["--source-index-range", eligible[0]];
      return ["--source-index-range", eligible[0]];
    }
  }

  if (!hasSourceIndexRangeFlag) {
    const envIndexRange = readEnvArg("npm_config_source_index_range");
    if (envIndexRange) out.push("--source-index-range", envIndexRange);
  }

  return out;
}

function readEnvArg(name) {
  const v = process.env[name];
  if (v == null) return "";
  const s = String(v).trim();
  if (s === "" || s.toLowerCase() === "true" || s.toLowerCase() === "false") {
    return "";
  }
  return s === "" ? "" : s;
}

function hasEnvFlag(name) {
  const v = process.env[name];
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1";
}
