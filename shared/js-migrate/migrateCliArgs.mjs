/**
 * พารามิเตอร์ CLI ร่วมสำหรับงาน migrate (แชร์ข้าม profile)
 *
 * --migrate-run-mode resume | overwrite | repair-from-log
 *    resume (ดีฟอลต์)  = ต่อจาก checkpoint, ไม่ทับแถวที่มีใน Postgres แล้ว (insert-only)
 *    overwrite         = migrate ทั้งชุดจากต้น, เขียนทับข้อมูลเดิม (ปิด checkpoint)
 *    repair-from-log   = เฉพาะ id จาก log ล่าสุดใน <profile>/js-migrate/logs
 *
 * --migrate-mode overwrite | insert-only  (บังคับพฤติกรรมแถว — แทน run-mode ด้านบนเมื่อระบุ)
 *
 * ช่วงลำดับแถวต้นทาง (1-based, inclusive) — ต้องเป็นช่วงด้วย -:
 *    --source-index-range 1-10 | 10-100 | 100-all | all
 *    หรือ --source-index-from 1 --source-index-to 100
 *
 * ช่วงค่า key ตัวเลขต้นทาง (inclusive) — ต้องเป็นช่วงด้วย -:
 *    --source-key-range 1-10 | 10-100 | 100-all | all | 50-
 *    หรือ --source-key-from 1 --source-key-to 100
 *
 * รายการ PK เฉพาะแถว (string คั่นด้วย comma ใน argv เดียว):
 *    --source-ids "1,2,3,4,5"   ← ต้องครอบด้วย " เสมอ (โดยเฉพาะ npm)
 *    --source-ids "5000"
 *
 * ค่าเก่า: --migrate-run-mode full ถือเป็น resume
 */

import {
  assertSourceIdsMandatoryQuotes,
  assertSourceIdsSingleArgvToken,
  parseSourceIdsString,
  parseSpacedNumericIdsParts,
  readNpmSourceIdsEnvValue,
  shouldSkipKeyRangeValidationForToken,
  shouldTreatBareNumericPairAsSourceIds,
  throwNpmSplitSourceIdsMistake,
} from "./sourceIdsSupport.mjs";
import { SOURCE_KEY_RANGE_SUPPORTED } from "./sourceKeyRangeSupport.mjs";

/**
 * @param {string[]} argv
 * @returns {{
 *   migrateRunMode: 'resume' | 'overwrite' | 'repair-from-log',
 *   migrateRowMode: 'overwrite' | 'insert-only',
 *   sourceIndexFrom: number | null,
 *   sourceIndexTo: number | null,
 *   sourceKeyNumericMin: string | null,
 *   sourceKeyNumericMax: string | null,
 *   hasSourceKeyCli: boolean,
 *   sourceIds: string[] | null,
 *   hasSourceIdsCli: boolean,
 *   rawArgvTail: string[]
 * }}
 */
export function parseMigrateCliArgs(argv = process.argv) {
  let runModeRaw = argvValue(argv, "--migrate-run-mode");
  if (runModeRaw == null) {
    runModeRaw = detectBareMigrateRunMode(argv);
  }
  let migrateRunMode;
  if (runModeRaw === "repair-from-log") {
    migrateRunMode = "repair-from-log";
  } else if (runModeRaw === "overwrite") {
    migrateRunMode = "overwrite";
  } else if (
    runModeRaw === "resume" ||
    runModeRaw === "full" ||
    runModeRaw == null ||
    String(runModeRaw).trim() === ""
  ) {
    migrateRunMode = "resume";
  } else {
    throw new Error(
      `--migrate-run-mode ไม่รู้จัก "${runModeRaw}" — ใช้ resume | overwrite | repair-from-log`,
    );
  }

  const migrateModeRaw = argvValue(argv, "--migrate-mode");
  let migrateRowMode;
  if (migrateModeRaw === "overwrite") {
    migrateRowMode = "overwrite";
  } else if (migrateModeRaw === "insert-only") {
    migrateRowMode = "insert-only";
  } else if (migrateRunMode === "overwrite" || migrateRunMode === "repair-from-log") {
    migrateRowMode = "overwrite";
  } else {
    migrateRowMode = "insert-only";
  }

  let sourceKeyNumericMin = null;
  let sourceKeyNumericMax = null;
  let hasSourceKeyCli = false;
  const keyFromRaw = argvValue(argv, "--source-key-from");
  const keyToRaw = argvValue(argv, "--source-key-to");
  assertSourceKeyRangeArgvShape(argv);
  const keyRangeStr = argvValue(argv, "--source-key-range");
  if (keyRangeStr != null) {
    hasSourceKeyCli = true;
    const parsed = parseSourceKeyRangeString(keyRangeStr);
    sourceKeyNumericMin = parsed.min === null ? null : String(parsed.min);
    sourceKeyNumericMax = parsed.max === null ? null : String(parsed.max);
  } else {
    if (keyFromRaw != null && String(keyFromRaw).trim() !== "") {
      hasSourceKeyCli = true;
      sourceKeyNumericMin = String(parseOptionalBig(keyFromRaw));
    }
    if (keyToRaw != null && String(keyToRaw).trim() !== "") {
      hasSourceKeyCli = true;
      sourceKeyNumericMax = String(parseOptionalBig(keyToRaw));
    }
  }
  if (
    sourceKeyNumericMin != null &&
    sourceKeyNumericMax != null &&
    BigInt(sourceKeyNumericMin) > BigInt(sourceKeyNumericMax)
  ) {
    throw new Error(
      `--source-key-from ต้องไม่เกิน --source-key-to (${sourceKeyNumericMin} > ${sourceKeyNumericMax})`,
    );
  }

  let sourceIndexFrom = parseOptionalPositiveInt(
    argvValue(argv, "--source-index-from"),
  );
  let sourceIndexTo = parseOptionalPositiveInt(argvValue(argv, "--source-index-to"));
  assertSourceIndexRangeArgvShape(argv);
  const indexRangeStr = argvValue(argv, "--source-index-range");
  if (indexRangeStr != null) {
    const parsed = parseSourceIndexRangeString(indexRangeStr);
    sourceIndexFrom = parsed.from;
    sourceIndexTo = parsed.to;
  }
  if (
    sourceIndexFrom != null &&
    sourceIndexTo != null &&
    sourceIndexFrom > sourceIndexTo
  ) {
    throw new Error(
      `--source-index-from ต้องไม่เกิน --source-index-to (${sourceIndexFrom} > ${sourceIndexTo})`,
    );
  }

  let sourceIds = null;
  let hasSourceIdsCli = false;
  const sourceIdParts = argvValuesAfterFlag(argv, "--source-ids");
  if (sourceIdParts != null) {
    hasSourceIdsCli = true;
    assertSourceIdsMandatoryQuotes(argv, sourceIdParts);
    const idsRaw =
      readNpmSourceIdsEnvValue() ?? String(sourceIdParts[0]).trim();
    sourceIds = parseSourceIdsString(idsRaw);
    if (sourceIds.length === 0) {
      throw new Error("--source-ids ต้องมีค่าอย่างน้อย 1 id");
    }
  }

  const rawArgvTail = [];
  return {
    migrateRunMode,
    migrateRowMode,
    sourceIndexFrom,
    sourceIndexTo,
    sourceKeyNumericMin,
    sourceKeyNumericMax,
    hasSourceKeyCli,
    sourceIds,
    hasSourceIdsCli,
    rawArgvTail,
  };
}

const SOURCE_KEY_RANGE_FORMAT_HELP =
  "รูปแบบที่รองรับ: 1-10, 10-100, 1-all, all, 50- (ต้องมี - คั่นช่วง ไม่ใช้ comma หรือเลขเดี่ยว)";

const SOURCE_INDEX_RANGE_FORMAT_HELP =
  "รูปแบบที่รองรับ: 1-10, 10-100, 100-all, all (ต้องมี - คั่นช่วง ไม่ใช้ comma หรือเลขเดี่ยว)";

/**
 * @param {string} raw
 * @param {string} flagLabel
 */
function throwCommaLooksLikeSourceIds(raw, flagLabel) {
  const parts = String(raw)
    .split(/[,;]+/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (parts.length >= 2) {
    throw new Error(
      `${flagLabel} ต้องเป็นช่วงด้วยเครื่องหมาย - ไม่ใช่รายการ id คั่น comma — ใช้ --source-ids "${parts.join(",")}" แทน`,
    );
  }
}

/**
 * ตรวจค่าช่วง --source-key-range ก่อน parse — ไม่ใช่ช่วงจะ throw ทันที
 * @param {string} rangeStr
 * @param {string} [flagLabel]
 */
export function validateSourceKeyRangeToken(
  rangeStr,
  flagLabel = "--source-key-range",
) {
  const raw = String(rangeStr ?? "").trim();
  if (raw === "") {
    throw new Error(
      `${flagLabel} ต้องระบุช่วง — ${SOURCE_KEY_RANGE_FORMAT_HELP}`,
    );
  }
  if (raw.includes(",")) {
    const m = raw.match(/^(-?\d+)\s*,\s*(-?\d+)$/);
    if (m) {
      throw new Error(
        `${flagLabel} ต้องเป็นช่วงด้วยเครื่องหมาย - ไม่ใช่ , — ตัวอย่าง: ${flagLabel} ${m[1]}-${m[2]}`,
      );
    }
    throwCommaLooksLikeSourceIds(raw, flagLabel);
    throw new Error(
      `${flagLabel} ต้องเป็นช่วงด้วยเครื่องหมาย - ไม่ใช่ , — ได้รับ ${raw}`,
    );
  }
  const spacedParts = parseSpacedNumericIdsParts(raw);
  if (spacedParts != null) {
    if (flagLabel === "--source-key-range") {
      throwNpmSplitSourceIdsMistake(spacedParts);
    }
    throw new Error(
      `${flagLabel} ต้องเป็นช่วงด้วยเครื่องหมาย - ไม่ใช่ช่องว่าง — ตัวอย่าง: ${flagLabel} ${spacedParts[0]}-${spacedParts[1]}`,
    );
  }
  const s = raw.toLowerCase();
  if (s === "all" || s === "*") return;
  if (!raw.includes("-")) {
    throw new Error(
      `${flagLabel} ต้องเป็นช่วง min-max ด้วยเครื่องหมาย - (ได้รับ ${raw}) — ${SOURCE_KEY_RANGE_FORMAT_HELP}`,
    );
  }
  const ok =
    /^(-?\d+)\s*-\s*(-?\d+|all)$/i.test(raw) ||
    /^(-?\d+)\s*-\s*$/i.test(raw) ||
    /^-\s*(-?\d+)$/i.test(raw);
  if (!ok) {
    throw new Error(
      `${flagLabel} ไม่ถูกต้อง (${raw}) — ${SOURCE_KEY_RANGE_FORMAT_HELP}`,
    );
  }
}

/**
 * ตรวจค่าช่วง --source-index-range ก่อน parse
 * @param {string} rangeStr
 * @param {string} [flagLabel]
 */
export function validateSourceIndexRangeToken(
  rangeStr,
  flagLabel = "--source-index-range",
) {
  const raw = String(rangeStr ?? "").trim();
  if (raw === "") {
    throw new Error(
      `${flagLabel} ต้องระบุช่วง — ${SOURCE_INDEX_RANGE_FORMAT_HELP}`,
    );
  }
  if (raw.includes(",")) {
    const m = raw.match(/^(\d+)\s*,\s*(\d+)$/);
    if (m) {
      throw new Error(
        `${flagLabel} ต้องเป็นช่วงด้วยเครื่องหมาย - ไม่ใช่ , — ตัวอย่าง: ${flagLabel} ${m[1]}-${m[2]}`,
      );
    }
    throwCommaLooksLikeSourceIds(raw, flagLabel);
    throw new Error(
      `${flagLabel} ต้องเป็นช่วงด้วยเครื่องหมาย - ไม่ใช่ , — ได้รับ ${raw}`,
    );
  }
  const spaced = raw.match(/^(\d+)\s+(\d+)$/);
  if (spaced) {
    throw new Error(
      `${flagLabel} ต้องเป็นช่วงด้วยเครื่องหมาย - ไม่ใช่ช่องว่าง — ตัวอย่าง: ${flagLabel} ${spaced[1]}-${spaced[2]}`,
    );
  }
  const s = raw.toLowerCase();
  if (s === "all" || s === "*") return;
  if (!raw.includes("-")) {
    throw new Error(
      `${flagLabel} ต้องเป็นช่วง min-max ด้วยเครื่องหมาย - (ได้รับ ${raw}) — ${SOURCE_INDEX_RANGE_FORMAT_HELP}`,
    );
  }
  if (!/^(\d+)\s*-\s*(\d+|all)$/i.test(raw)) {
    throw new Error(
      `${flagLabel} ไม่ถูกต้อง (${raw}) — ${SOURCE_INDEX_RANGE_FORMAT_HELP}`,
    );
  }
}

/** @deprecated ใช้ validateSourceKeyRangeToken หรือ validateSourceIndexRangeToken */
export function rejectCommaRangeSeparator(rangeStr, flagLabel = "--source-key-range") {
  if (flagLabel === "--source-index-range") {
    validateSourceIndexRangeToken(rangeStr, flagLabel);
  } else {
    validateSourceKeyRangeToken(rangeStr, flagLabel);
  }
}

const SKIP_ONE_VALUE_FLAGS = new Set([
  "--source-key-range",
  "--source-index-range",
  "--source-key-from",
  "--source-key-to",
  "--source-index-from",
  "--source-index-to",
  "--migrate-run-mode",
  "--migrate-mode",
  "--config",
  "--profile",
]);

/** @param {string[]} rawArgs */
function collectBareMigrateArgvTokens(rawArgs) {
  /** @type {string[]} */
  const bare = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = String(rawArgs[i] ?? "").trim();
    if (!a) continue;
    const low = a.toLowerCase();
    if (a.startsWith("-")) {
      if (low === "--source-ids") {
        i++;
        while (i < rawArgs.length && !String(rawArgs[i]).startsWith("-")) i++;
        continue;
      }
      if (SKIP_ONE_VALUE_FLAGS.has(low)) {
        if (i + 1 < rawArgs.length && !String(rawArgs[i + 1]).startsWith("-")) {
          i++;
        }
      }
      continue;
    }
    if (
      low === "resume" ||
      low === "full" ||
      low === "overwrite" ||
      low === "repair-from-log" ||
      low === "insert-only"
    ) {
      continue;
    }
    bare.push(a);
  }
  return bare;
}

function throwCommaKeyRangeMistake(numericOnly) {
  throw new Error(
    `--source-key-range ต้องเป็นช่วงด้วยเครื่องหมาย - ไม่ใช่ตัวเลขแยกหลายค่า (ได้ ${numericOnly.join(" กับ ")}, มักเกิดจาก comma ใน shell) — ตัวอย่าง: --source-key-range ${numericOnly[0]}-${numericOnly[1]}. ${SOURCE_KEY_RANGE_FORMAT_HELP}`,
  );
}

/**
 * npm บน Windows มักกลืน `--source-key-range` แล้วส่งแค่ `19` `469`
 * @param {string | null} profileKey
 * @param {string[]} rawArgs argv หลัง profile
 * @param {string[]} [fullArgv] process.argv ทั้งก้อน (ตรวจว่ามี flag จริงหรือไม่)
 */
export function assertNpmSwallowedSourceKeyRange(
  profileKey,
  rawArgs,
  fullArgv = [],
) {
  if (profileKey != null && !(profileKey in SOURCE_KEY_RANGE_SUPPORTED)) {
    return;
  }

  const bare = collectBareMigrateArgvTokens(rawArgs);
  const numericOnly = bare.filter((t) => /^-?\d+$/.test(t));
  const hasExplicitKeyRangeFlag = fullArgv.some(
    (a) =>
      String(a) === "--source-key-range" ||
      String(a).toLowerCase().startsWith("--source-key-range="),
  );
  const npmAte =
    String(process.env.npm_config_source_key_range ?? "")
      .trim()
      .toLowerCase() === "true";

  if (
    numericOnly.length >= 2 &&
    (npmAte || !hasExplicitKeyRangeFlag)
  ) {
    if (shouldTreatBareNumericPairAsSourceIds(profileKey, fullArgv)) {
      throwNpmSplitSourceIdsMistake(numericOnly, profileKey ?? "billing");
    }
    throwCommaKeyRangeMistake(numericOnly);
  }

  for (const token of bare) {
    if (/^-?\d+$/.test(token)) continue;
    const spacedParts = parseSpacedNumericIdsParts(token);
    if (
      spacedParts != null &&
      shouldTreatBareNumericPairAsSourceIds(profileKey, fullArgv)
    ) {
      throwNpmSplitSourceIdsMistake(spacedParts);
    }
    if (
      shouldSkipKeyRangeValidationForToken(
        token,
        profileKey,
        fullArgv,
        rawArgs,
      )
    ) {
      continue;
    }
    validateSourceKeyRangeToken(token);
  }
  if (numericOnly.length === 1 && !hasExplicitKeyRangeFlag) {
    validateSourceKeyRangeToken(numericOnly[0]);
  }
}

/**
 * ตรวจ argv หลัง normalize — กรณี PowerShell แยก `19,469` เป็น `19` กับ `469`
 * @param {string[]} argv
 */
export function assertSourceKeyRangeArgvShape(argv) {
  const idx = argv.indexOf("--source-key-range");
  if (idx < 0) return;
  const valIdx = idx + 1;
  if (valIdx >= argv.length || String(argv[valIdx]).startsWith("-")) {
    throw new Error(
      `--source-key-range ต้องมีค่าช่วง — ${SOURCE_KEY_RANGE_FORMAT_HELP}`,
    );
  }
  const val = String(argv[valIdx]).trim();
  const next = argv[valIdx + 1];
  if (
    next != null &&
    !String(next).startsWith("-") &&
    /^-?\d+$/.test(val) &&
    /^-?\d+$/.test(String(next).trim())
  ) {
    throw new Error(
      `พบ --source-key-range ${val} แล้วตามด้วย ${String(next).trim()} — ใช้ช่วงด้วย - เช่น --source-key-range ${val}-${String(next).trim()}`,
    );
  }
  validateSourceKeyRangeToken(val, "--source-key-range");
}

/**
 * ตรวจ argv หลัง normalize — กรณี PowerShell แยกช่วง index เป็นหลาย arg
 * @param {string[]} argv
 */
export function assertSourceIndexRangeArgvShape(argv) {
  const idx = argv.indexOf("--source-index-range");
  if (idx < 0) return;
  const valIdx = idx + 1;
  if (valIdx >= argv.length || String(argv[valIdx]).startsWith("-")) {
    throw new Error(
      `--source-index-range ต้องมีค่าช่วง — ${SOURCE_INDEX_RANGE_FORMAT_HELP}`,
    );
  }
  const val = String(argv[valIdx]).trim();
  const next = argv[valIdx + 1];
  if (
    next != null &&
    !String(next).startsWith("-") &&
    /^\d+$/.test(val) &&
    /^\d+$/.test(String(next).trim())
  ) {
    throw new Error(
      `พบ --source-index-range ${val} แล้วตามด้วย ${String(next).trim()} — ใช้ช่วงด้วย - เช่น --source-index-range ${val}-${String(next).trim()}`,
    );
  }
  validateSourceIndexRangeToken(val, "--source-index-range");
}

/**
 * @param {string} rangeStr เช่น 1-100, 1-all, all, 50- (ต้องมี - ยกเว้น all)
 * @returns {{ min: bigint|null, max: bigint|null }}
 */
export function parseSourceKeyRangeString(rangeStr) {
  const raw = String(rangeStr).trim();
  validateSourceKeyRangeToken(raw);
  const s = raw.toLowerCase();
  if (s === "all" || s === "*") {
    return { min: null, max: null };
  }
  const m = s.match(/^(-?\d+)\s*-\s*(-?\d+|all)$/);
  if (m) {
    const min = BigInt(m[1]);
    const maxPart = m[2];
    const max = maxPart === "all" ? null : BigInt(maxPart);
    return { min, max };
  }
  const openHi = s.match(/^(-?\d+)\s*-\s*$/);
  if (openHi) {
    return { min: BigInt(openHi[1]), max: null };
  }
  const openLo = s.match(/^-\s*(-?\d+)$/);
  if (openLo) {
    return { min: null, max: BigInt(openLo[1]) };
  }
  throw new Error(
    `--source-key-range ไม่ถูกต้อง (${raw}) — ${SOURCE_KEY_RANGE_FORMAT_HELP}`,
  );
}

export function migrateCliOverridesFromArgv(argv = process.argv) {
  const {
    migrateRunMode,
    migrateRowMode,
    sourceIndexFrom,
    sourceIndexTo,
    sourceKeyNumericMin,
    sourceKeyNumericMax,
    hasSourceKeyCli,
    sourceIds,
    hasSourceIdsCli,
  } = parseMigrateCliArgs(argv);
  /** @type {Record<string, unknown>} */
  const o = {};
  o.migrateRunMode = migrateRunMode;
  o.migrateRowMode = migrateRowMode;
  if (
    migrateRunMode === "repair-from-log" ||
    migrateRunMode === "overwrite" ||
    hasSourceIdsCli
  ) {
    o.enableCheckpoint = false;
  } else {
    o.enableCheckpoint = true;
  }
  if (sourceIndexFrom != null) o.sourceIndexFrom = sourceIndexFrom;
  if (sourceIndexTo != null) o.sourceIndexTo = sourceIndexTo;
  if (hasSourceKeyCli) {
    o.sourceKeyNumericMin = sourceKeyNumericMin;
    o.sourceKeyNumericMax = sourceKeyNumericMax;
  }
  if (hasSourceIdsCli && sourceIds != null) {
    o.sourceIds = sourceIds;
  }
  return o;
}

/** แสดงโหมดที่ใช้ใน stderr */
export function logMigrationRunMode(migration, tableKey) {
  const run = String(migration?.migrateRunMode ?? "resume");
  const row = String(migration?.migrateRowMode ?? "insert-only");
  if (run === "repair-from-log") {
    console.error(
      `>>> [${tableKey}] migrateRunMode=repair-from-log (เฉพาะ id จาก log ล่าสุด, migrateRowMode=${row})`,
    );
  } else if (run === "overwrite") {
    console.error(
      `>>> [${tableKey}] migrateRunMode=overwrite (เริ่มใหม่ทั้งชุด, เขียนทับ, checkpoint=ปิด)`,
    );
  } else {
    console.error(
      `>>> [${tableKey}] migrateRunMode=resume (ต่อ checkpoint, ไม่ทับของเดิม, migrateRowMode=${row})`,
    );
  }
}

/** แสดงช่วงค่า key ตัวเลขจาก CLI/config */
export function logSourceNumericKeyRange(migration, tableKey) {
  const { min, max } = readNumericSourceKeyBounds(migration);
  if (min == null && max == null) return;
  console.error(
    `>>> [${tableKey}] source key numeric range: min=${min ?? "unset"} max=${max ?? "unset"} (inclusive)`,
  );
}

/**
 * @param {Record<string, unknown>} migration merged migration config + CLI (optional bigint string)
 * @returns {{ min: bigint | null, max: bigint | null }}
 */
export function readNumericSourceKeyBounds(migration) {
  /** @type {unknown} */
  const a = migration?.sourceKeyNumericMin;
  /** @type {unknown} */
  const b = migration?.sourceKeyNumericMax;
  return {
    min: a != null && String(a).trim() !== "" ? BigInt(String(a).trim()) : null,
    max: b != null && String(b).trim() !== "" ? BigInt(String(b).trim()) : null,
  };
}

/** ใส่ใน mssql/sql request พร้อมผูก NULL เมื่อไม่จำกัด */
export function bindMigrateSrcNumericRange(req, migration, sqlPkg) {
  const { min, max } = readNumericSourceKeyBounds(migration);
  const sql = sqlPkg;
  req.input(
    "migrateSrcKeyMin",
    sql.BigInt,
    min === null ? null : min < -9223372036854775808n ? -9223372036854775808n : min,
  );
  req.input(
    "migrateSrcKeyMax",
    sql.BigInt,
    max === null ? null : max > 9223372036854775807n ? 9223372036854775807n : max,
  );
}

/**
 * @returns {bigint}
 */
export function clampKeysetLowerBound(afterExclusive, numericMinExclusive, sqlPkg) {
  if (numericMinExclusive == null) return afterExclusive;
  const min = numericMinExclusive;
  const wantAfter = min - 1n;
  if (afterExclusive >= wantAfter) return afterExclusive;
  return wantAfter;
}

/** @returns {string[] | null} ค่าหลัง flag (ไม่ join — ใช้ตรวจว่าต้องเป็น arg เดียว) */
function argvValuesAfterFlag(argv, name) {
  const idx = argv.indexOf(name);
  if (idx < 0) return null;
  /** @type {string[]} */
  const parts = [];
  for (let i = idx + 1; i < argv.length; i++) {
    const a = String(argv[i] ?? "");
    if (a.startsWith("-")) break;
    const s = a.trim();
    if (s !== "") parts.push(s);
  }
  return parts.length === 0 ? null : parts;
}

function argvValue(argv, name) {
  const idx = argv.indexOf(name);
  if (idx < 0 || idx + 1 >= argv.length) return null;
  return argv[idx + 1];
}

/** npm บางครั้งส่งแค่คำว่า overwrite โดยไม่มี --migrate-run-mode */
function detectBareMigrateRunMode(argv) {
  const known = new Set([
    "resume",
    "full",
    "overwrite",
    "repair-from-log",
    "insert-only",
  ]);
  const skipNext = new Set(["--config", "--profile", "--migrate-run-mode", "--migrate-mode", "--source-key-range", "--source-key-from", "--source-key-to", "--source-index-range", "--source-index-from", "--source-index-to", "--source-ids"]);
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("-")) {
      if (skipNext.has(a)) i++;
      continue;
    }
    const low = String(a).trim().toLowerCase();
    if (low === "repair-from-log" || low === "overwrite" || low === "resume" || low === "full") {
      return low;
    }
    if (known.has(low)) continue;
  }
  return null;
}

function parseOptionalBig(s) {
  if (s == null || String(s).trim() === "") return null;
  try {
    return BigInt(String(s).trim());
  } catch {
    throw new Error(`ค่าไม่ใช่เลขเต็ม: ${JSON.stringify(s)}`);
  }
}

function argvHas(argv, name) {
  return argv.indexOf(name) >= 0;
}

/**
 * @param {string} rangeStr เช่น 1-100, 100-all, all
 * @returns {{ from: number|null, to: number|null }}
 */
export function parseSourceIndexRangeString(rangeStr) {
  const raw = String(rangeStr).trim();
  validateSourceIndexRangeToken(raw);
  const s = raw.toLowerCase();
  if (s === "all" || s === "*") return { from: null, to: null };
  const m = s.match(/^(\d+)\s*-\s*(\d+|all)$/);
  if (m) {
    return {
      from: Number.parseInt(m[1], 10),
      to: m[2] === "all" ? null : Number.parseInt(m[2], 10),
    };
  }
  throw new Error(
    `--source-index-range ไม่ถูกต้อง (${raw}) — ${SOURCE_INDEX_RANGE_FORMAT_HELP}`,
  );
}

function parseOptionalPositiveInt(s) {
  if (s == null || String(s).trim() === "") return null;
  const n = Number.parseInt(String(s).trim(), 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`ค่า index ต้องเป็นจำนวนเต็มบวก: ${JSON.stringify(s)}`);
  }
  return n;
}
