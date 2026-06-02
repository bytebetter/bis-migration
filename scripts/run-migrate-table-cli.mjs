/**
 * npm run migrate:<profile> — ส่งต่อ argv หลัง -- ให้ migrate-from-mssql.mjs ครบ
 * (แก้กรณี Windows/npm ทำให้ --migrate-run-mode / --source-index-range หาย)
 */
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSourceKeyRangeSupported } from "../shared/js-migrate/sourceKeyRangeSupport.mjs";
import {
  assertSourceIdsMandatoryQuotes,
  assertSourceIdsSingleArgvToken,
  assertSourceIdsSupported,
  looksLikeSourceIdsArgvValue,
  npmConfigAteSourceIdsFlag,
  parseSpacedNumericIdsParts,
  sourceIdsKeptInSingleArgvToken,
  shouldTreatBareNumericPairAsSourceIds,
  SOURCE_IDS_PK_PROFILES,
  SOURCE_IDS_QUOTE_EXAMPLE,
  throwNpmSplitSourceIdsMistake,
} from "../shared/js-migrate/sourceIdsSupport.mjs";
import {
  assertNpmSwallowedSourceKeyRange,
  assertSourceIndexRangeArgvShape,
  assertSourceKeyRangeArgvShape,
  parseMigrateCliArgs,
  validateSourceIndexRangeToken,
  validateSourceKeyRangeToken,
} from "../shared/js-migrate/migrateCliArgs.mjs";
import { SOURCE_KEY_RANGE_SUPPORTED } from "../shared/js-migrate/sourceKeyRangeSupport.mjs";

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
  billing: "billing",
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
/** @type {string[]} */
let forwarded = [];
/** @type {string[]} */
let recovered = [];
try {
  ({ args: forwarded, recovered } = normalizeForwardedArgs(
    process.argv.slice(3),
    profile,
    process.argv,
  ));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
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
      "  npm run migrate:patient_info -- --source-ids \"1,2,3,4,5\"  (ต้องมี \" ครอบค่าเสมอ)",
      "  npm run migrate:patient_info -- --source-index-range 1-20 --migrate-mode insert-only",
      "  npm run migrate:billing -- --source-key-range 19-469",
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
  assertSourceKeyRangeArgvShape(forwarded);
  assertSourceIndexRangeArgvShape(forwarded);
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
  if (parsed.hasSourceIdsCli) {
    assertSourceIdsSupported(
      profile,
      { sourceIds: parsed.sourceIds },
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
function normalizeForwardedArgs(args, profileKey = null, fullArgv = []) {
  args = prependRecoveredSourceIdsArgv(args, profileKey, fullArgv);
  rejectMisplacedSourceIdsBareArgs(args, profileKey, fullArgv);
  assertNpmSwallowedSourceKeyRange(profileKey, args, fullArgv);

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
        const val = String(next).trim();
        const next2 = args[i + 2];
        if (
          next2 != null &&
          !String(next2).startsWith("-") &&
          /^\d+$/.test(val) &&
          /^\d+$/.test(String(next2).trim())
        ) {
          throw new Error(
            `พบ --source-index-range ${val} แล้วตามด้วย ${String(next2).trim()} — ใช้ช่วงด้วย - เช่น --source-index-range ${val}-${String(next2).trim()}`,
          );
        }
        validateSourceIndexRangeToken(val);
        pass1.push(val);
        i++;
      }
      continue;
    }
    if (low === "--source-key-range") {
      pass1.push(a);
      const next = args[i + 1];
      if (next != null && !String(next).startsWith("-")) {
        const val = String(next).trim();
        const next2 = args[i + 2];
        if (
          next2 != null &&
          !String(next2).startsWith("-") &&
          /^-?\d+$/.test(val) &&
          /^-?\d+$/.test(String(next2).trim())
        ) {
          throw new Error(
            `พบ --source-key-range ${val} แล้วตามด้วย ${String(next2).trim()} — ใช้ช่วงด้วย - เช่น --source-key-range ${val}-${String(next2).trim()}`,
          );
        }
        validateSourceKeyRangeToken(val);
        pass1.push(val);
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
    if (low === "--source-ids") {
      pass1.push(a);
      /** @type {string[]} */
      const idParts = [];
      while (i + 1 < args.length && !String(args[i + 1]).startsWith("-")) {
        i++;
        const part = String(args[i]).trim();
        if (part !== "") idParts.push(part);
      }
      if (idParts.length > 0) {
        assertSourceIdsSingleArgvToken(idParts);
        pass1.push(idParts[0]);
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
  let hasSourceIds = pass1.includes("--source-ids");

  const envKeyRangeRaw = process.env.npm_config_source_key_range;
  const envKeyRange = readEnvArg("npm_config_source_key_range");
  const envSourceIdsRaw = process.env.npm_config_source_ids;
  const envSourceIds = readEnvArg("npm_config_source_ids");
  /** npm บน Windows มักกลืน --source-key-range แล้ว set env เป็น "true" ค่าช่วงเหลือเป็น arg เปล่า */
  const npmAteSourceKeyFlag =
    String(envKeyRangeRaw ?? "").trim().toLowerCase() === "true";
  const npmAteSourceIdsFlag = npmConfigAteSourceIdsFlag();
  const wantsSourceKey =
    hasSourceKeyRange ||
    hasSourceKeyFrom ||
    hasSourceKeyTo ||
    npmAteSourceKeyFlag ||
    Boolean(readEnvArg("npm_config_source_key_from")) ||
    Boolean(readEnvArg("npm_config_source_key_to")) ||
    (envKeyRange !== "" && !npmAteSourceKeyFlag);
  const wantsSourceIds =
    npmAteSourceIdsFlag || (envSourceIds !== "" && !npmAteSourceIdsFlag);
  const sourceIdsProfile =
    profileKey != null && profileKey in SOURCE_IDS_PK_PROFILES;
  const keyRangeProfile =
    profileKey != null && profileKey in SOURCE_KEY_RANGE_SUPPORTED;

  /** @type {string[]} */
  const out = [];

  for (let pi = 0; pi < pass1.length; pi++) {
    const a = pass1[pi];
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
      !hasSourceIds &&
      (RANGE_VALUE_RE.test(a) || SINGLE_INDEX_RE.test(a))
    ) {
      if (wantsSourceKey) {
        if (
          SINGLE_INDEX_RE.test(a) &&
          !RANGE_VALUE_RE.test(a) &&
          pass1[pi + 1] != null &&
          !String(pass1[pi + 1]).startsWith("-") &&
          SINGLE_INDEX_RE.test(String(pass1[pi + 1]).trim())
        ) {
          const hi = String(pass1[pi + 1]).trim();
          if (sourceIdsProfile && npmConfigAteSourceIdsFlag()) {
            throwNpmSplitSourceIdsMistake([a, hi], profileKey ?? "billing");
          }
          throw new Error(
            `พบตัวเลข ${a} กับ ${hi} แยกกัน — ใช้ --source-key-range ${a}-${hi} (ต้องมีเครื่องหมาย - ไม่ใช้ comma)`,
          );
        }
        const rangeVal = envKeyRange && !npmAteSourceKeyFlag ? envKeyRange : a;
        validateSourceKeyRangeToken(rangeVal);
        out.push("--source-key-range", rangeVal);
        hasSourceKeyRange = true;
        recovered.push(`--source-key-range ${rangeVal}`);
        continue;
      }
      if (keyRangeProfile && SINGLE_INDEX_RE.test(a) && !RANGE_VALUE_RE.test(a)) {
        validateSourceKeyRangeToken(a);
      }
      validateSourceIndexRangeToken(a);
      out.push("--source-index-range", a);
      hasSourceIndexRange = true;
      recovered.push(`--source-index-range ${a}`);
      continue;
    }

    out.push(a);
  }

  if (!hasSourceIndexRange && !wantsSourceKey && !wantsSourceIds) {
    const envIndexRange = readEnvArg("npm_config_source_index_range");
    if (envIndexRange) {
      validateSourceIndexRangeToken(envIndexRange);
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
    validateSourceKeyRangeToken(envKeyRange);
    out.push("--source-key-range", envKeyRange);
    recovered.push(`--source-key-range ${envKeyRange} (env)`);
  }

  if (!hasSourceIds && npmAteSourceIdsFlag) {
    /** @type {string[]} */
    const bareIds = [];
    for (const a of pass1) {
      if (a.startsWith("--")) continue;
      const low = a.toLowerCase();
      if (RUN_MODE_BARE.has(low) || ROW_MODE_BARE.has(low)) continue;
      bareIds.push(a);
    }
    if (bareIds.length === 0) {
      throw new Error(
        `npm กลืน --source-ids แต่ไม่มีค่า id — ครอบด้วย " เช่น ${SOURCE_IDS_QUOTE_EXAMPLE}`,
      );
    }
    if (bareIds.length > 1) {
      throwNpmSplitSourceIdsMistake(bareIds, profileKey ?? "billing");
    }
    out.push("--source-ids", bareIds[0]);
    hasSourceIds = true;
    recovered.push(`--source-ids ${bareIds[0]}`);
  }

  if (hasSourceIds) {
    const parts = collectArgvPartsAfterFlag(out, "--source-ids");
    if (parts != null) {
      assertSourceIdsMandatoryQuotes(fullArgv, parts);
    }
  }

  assertSourceKeyRangeArgvShape(out);
  assertSourceIndexRangeArgvShape(out);

  return { args: out, recovered };
}

/** @param {string[]} argv @param {string} flag */
function collectArgvPartsAfterFlag(argv, flag) {
  const start = argv.indexOf(flag);
  if (start < 0) return null;
  /** @type {string[]} */
  const parts = [];
  for (let i = start + 1; i < argv.length; i++) {
    if (argv[i].startsWith("--")) break;
    parts.push(argv[i]);
  }
  return parts.length === 0 ? null : parts;
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

/**
 * npm กลืน --source-ids แล้วเหลือแค่ 19 469 / 19,469 โดยไม่มี flag
 *
 * @param {string[]} args
 * @param {string | null} profileKey
 * @param {string[]} fullArgv
 */
function rejectMisplacedSourceIdsBareArgs(args, profileKey, fullArgv) {
  if (args.some((a) => String(a) === "--source-ids")) return;
  if (!shouldTreatBareNumericPairAsSourceIds(profileKey, fullArgv)) return;

  /** @type {string[]} */
  const bare = [];
  for (const a of args) {
    const s = String(a ?? "").trim();
    if (!s || s.startsWith("-")) continue;
    const low = s.toLowerCase();
    if (RUN_MODE_BARE.has(low) || ROW_MODE_BARE.has(low)) continue;
    bare.push(s);
  }
  if (bare.length === 0) return;

  const pk = profileKey ?? "billing";
  const numericOnly = bare.filter((t) => /^-?\d+$/.test(t));
  if (numericOnly.length >= 2 && numericOnly.length === bare.length) {
    throwNpmSplitSourceIdsMistake(numericOnly, pk);
  }
  if (bare.length === 1) {
    const spaced = parseSpacedNumericIdsParts(bare[0]);
    if (spaced) throwNpmSplitSourceIdsMistake(spaced, pk);
  }
}

/**
 * npm กลืน --source-ids แต่ค่า "19,469" ยังอยู่ argv เดียว → ใส่ flag กลับ
 *
 * @param {string[]} args
 * @param {string | null} profileKey
 * @param {string[]} fullArgv
 * @returns {string[]}
 */
function prependRecoveredSourceIdsArgv(args, profileKey, fullArgv) {
  if (args.some((a) => String(a) === "--source-ids")) return args;
  /** @type {string[]} */
  const bare = [];
  for (const a of args) {
    const s = String(a ?? "").trim();
    if (!s || s.startsWith("-")) continue;
    const low = s.toLowerCase();
    if (RUN_MODE_BARE.has(low) || ROW_MODE_BARE.has(low)) continue;
    bare.push(s);
  }
  if (
    bare.length === 1 &&
    sourceIdsKeptInSingleArgvToken([bare[0]]) &&
    shouldTreatBareNumericPairAsSourceIds(profileKey, fullArgv)
  ) {
    return ["--source-ids", bare[0]];
  }
  return args;
}
