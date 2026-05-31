/**
 * npm run migrate:<profile> — ส่งต่อ argv หลัง -- ให้ migrate-from-mssql.mjs ครบ
 * (แก้กรณี Windows/npm ทำให้ --migrate-run-mode / --source-index-range หาย)
 */
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSourceKeyRangeSupported } from "../shared/js-migrate/sourceKeyRangeSupport.mjs";
import { parseMigrateCliArgs } from "../shared/js-migrate/migrateCliArgs.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const RANGE_VALUE_RE = /^-?\d+\s*-\s*(-?\d+|all)?$/i;
const SINGLE_INDEX_RE = /^(all|\*|-?\d+)$/i;
const RUN_MODE_BARE = new Set([
  "resume",
  "full",
  "overwrite",
  "repair-from-log",
]);
const ROW_MODE_BARE = new Set(["insert-only", "overwrite"]);

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
const { args: forwarded, recovered } = normalizeForwardedArgs(
  process.argv.slice(3),
);
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
      "  npm run migrate:examination -- --source-key-range 1000-5000",
      "  npm run migrate:patient_info -- --source-index-range 1-20 --migrate-mode insert-only",
    ].join("\n"),
  );
  process.exit(1);
}

if (recovered.length > 0) {
  console.error(
    `>>> [migrate-cli] npm/Windows กลืน flag — แปลงกลับเป็น: ${recovered.join(" ")}`,
  );
}

try {
  const parsed = parseMigrateCliArgs([
    process.execPath,
    "run-migrate-table-cli.mjs",
    ...forwarded,
  ]);
  if (parsed.hasSourceKeyCli) {
    assertSourceKeyRangeSupported(
      profile,
      {
        sourceKeyNumericMin: parsed.sourceKeyNumericMin,
        sourceKeyNumericMax: parsed.sourceKeyNumericMax,
      },
      true,
    );
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
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
 * @param {string[]} args
 * @returns {{ args: string[], recovered: string[] }}
 */
function normalizeForwardedArgs(args) {
  /** @type {string[]} */
  const recovered = [];
  /** @type {string[]} */
  const pass1 = [];

  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    const a = String(raw ?? "").trim();
    const low = a.toLowerCase();
    if (!a) continue;

    if (low === "--source-index-range") {
      pass1.push(a);
      const next = args[i + 1];
      if (next != null && !String(next).startsWith("-")) {
        pass1.push(String(next));
        i++;
      }
      continue;
    }
    if (low === "--source-key-range") {
      pass1.push(a);
      const next = args[i + 1];
      if (next != null && !String(next).startsWith("-")) {
        pass1.push(String(next));
        i++;
      }
      continue;
    }
    if (low === "--source-key-from") {
      pass1.push(a);
      const next = args[i + 1];
      if (next != null && !String(next).startsWith("-")) {
        pass1.push(String(next));
        i++;
      }
      continue;
    }
    if (low === "--source-key-to") {
      pass1.push(a);
      const next = args[i + 1];
      if (next != null && !String(next).startsWith("-")) {
        pass1.push(String(next));
        i++;
      }
      continue;
    }
    if (low === "--source-index-from") {
      pass1.push(a);
      const next = args[i + 1];
      if (next != null && !String(next).startsWith("-")) {
        pass1.push(String(next));
        i++;
      }
      continue;
    }
    if (low === "--source-index-to") {
      pass1.push(a);
      const next = args[i + 1];
      if (next != null && !String(next).startsWith("-")) {
        pass1.push(String(next));
        i++;
      }
      continue;
    }
    if (low === "--migrate-run-mode" || low === "--migrate-mode") {
      pass1.push(a);
      const next = args[i + 1];
      if (next != null && !String(next).startsWith("-")) {
        pass1.push(String(next));
        i++;
      }
      continue;
    }

    pass1.push(a);
  }

  let hasSourceIndexRange = pass1.includes("--source-index-range");
  let hasSourceIndexFrom = pass1.includes("--source-index-from");
  let hasSourceIndexTo = pass1.includes("--source-index-to");
  let hasSourceKeyRange = pass1.includes("--source-key-range");
  let hasSourceKeyFrom = pass1.includes("--source-key-from");
  let hasSourceKeyTo = pass1.includes("--source-key-to");

  const envKeyRangeRaw = process.env.npm_config_source_key_range;
  const envKeyRange = readEnvArg("npm_config_source_key_range");
  /** npm บน Windows มักกลืน --source-key-range แล้ว set env เป็น "true" ค่าช่วงเหลือเป็น arg เปล่า */
  const npmAteSourceKeyFlag =
    String(envKeyRangeRaw ?? "").trim().toLowerCase() === "true";
  const wantsSourceKey =
    hasSourceKeyRange ||
    hasSourceKeyFrom ||
    hasSourceKeyTo ||
    npmAteSourceKeyFlag ||
    Boolean(readEnvArg("npm_config_source_key_from")) ||
    Boolean(readEnvArg("npm_config_source_key_to")) ||
    (envKeyRange !== "" && !npmAteSourceKeyFlag);

  /** @type {string[]} */
  const out = [];

  for (const a of pass1) {
    if (a.startsWith("--")) {
      out.push(a);
      continue;
    }

    const low = a.toLowerCase();

    if (RUN_MODE_BARE.has(low)) {
      const mode = low === "full" ? "resume" : low;
      out.push("--migrate-run-mode", mode);
      recovered.push(`--migrate-run-mode ${mode}`);
      continue;
    }

    if (ROW_MODE_BARE.has(low)) {
      out.push("--migrate-mode", low);
      recovered.push(`--migrate-mode ${low}`);
      continue;
    }

    if (
      !hasSourceIndexRange &&
      !hasSourceIndexFrom &&
      !hasSourceIndexTo &&
      !hasSourceKeyRange &&
      !hasSourceKeyFrom &&
      !hasSourceKeyTo &&
      (RANGE_VALUE_RE.test(a) || SINGLE_INDEX_RE.test(a))
    ) {
      if (wantsSourceKey) {
        const rangeVal = envKeyRange && !npmAteSourceKeyFlag ? envKeyRange : a;
        out.push("--source-key-range", rangeVal);
        hasSourceKeyRange = true;
        recovered.push(`--source-key-range ${rangeVal}`);
        continue;
      }
      out.push("--source-index-range", a);
      hasSourceIndexRange = true;
      recovered.push(`--source-index-range ${a}`);
      continue;
    }

    out.push(a);
  }

  if (!hasSourceIndexRange && !wantsSourceKey) {
    const envIndexRange = readEnvArg("npm_config_source_index_range");
    if (envIndexRange) {
      out.push("--source-index-range", envIndexRange);
      recovered.push(`--source-index-range ${envIndexRange} (env)`);
      hasSourceIndexRange = true;
    }
  }

  if (
    !hasSourceKeyRange &&
    !hasSourceKeyFrom &&
    envKeyRange &&
    !npmAteSourceKeyFlag
  ) {
    out.push("--source-key-range", envKeyRange);
    recovered.push(`--source-key-range ${envKeyRange} (env)`);
  }

  return { args: out, recovered };
}

function readEnvArg(name) {
  const v = process.env[name];
  if (v == null) return "";
  const s = String(v).trim();
  if (s === "" || s.toLowerCase() === "true" || s.toLowerCase() === "false") {
    return "";
  }
  return s;
}
