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
 * ช่วงลำดับแถวต้นทาง (1-based, inclusive):
 *    --source-index-range 1-100 | 100-all | all
 *    หรือ --source-index-from 1 --source-index-to 100
 *
 * ค่าเก่า: --migrate-run-mode full ถือเป็น resume
 */

/**
 * @param {string[]} argv
 * @returns {{
 *   migrateRunMode: 'resume' | 'overwrite' | 'repair-from-log',
 *   migrateRowMode: 'overwrite' | 'insert-only',
 *   sourceIndexFrom: number | null,
 *   sourceIndexTo: number | null,
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

  if (
    argvHas(argv, "--source-key-range") ||
    argvHas(argv, "--source-key-from") ||
    argvHas(argv, "--source-key-to")
  ) {
    throw new Error(
      "เลิกใช้ --source-key-range/--source-key-from/--source-key-to แล้ว ให้ใช้ --source-index-range หรือ --source-index-from/--source-index-to แทน",
    );
  }

  let sourceIndexFrom = parseOptionalPositiveInt(
    argvValue(argv, "--source-index-from"),
  );
  let sourceIndexTo = parseOptionalPositiveInt(argvValue(argv, "--source-index-to"));
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

  const rawArgvTail = [];
  return {
    migrateRunMode,
    migrateRowMode,
    sourceIndexFrom,
    sourceIndexTo,
    rawArgvTail,
  };
}

/**
 * @param {string} rangeStr เช่น 1-100, 1-all, all, 50-
 * @returns {{ min: bigint|null, max: bigint|null }}
 */
export function parseSourceKeyRangeString(rangeStr) {
  const s = String(rangeStr).trim().toLowerCase();
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
  const single = s.match(/^(-?\d+)$/);
  if (single) {
    const v = BigInt(single[1]);
    return { min: v, max: v };
  }
  throw new Error(
    `--source-key-range ไม่ถูกต้อง "${rangeStr}" — ใช้รูป เช่น 1-100, 1-all, all, 50-`,
  );
}

export function migrateCliOverridesFromArgv(argv = process.argv) {
  const {
    migrateRunMode,
    migrateRowMode,
    sourceIndexFrom,
    sourceIndexTo,
  } = parseMigrateCliArgs(argv);
  /** @type {Record<string, unknown>} */
  const o = {};
  o.migrateRunMode = migrateRunMode;
  o.migrateRowMode = migrateRowMode;
  if (migrateRunMode === "repair-from-log" || migrateRunMode === "overwrite") {
    o.enableCheckpoint = false;
  } else {
    o.enableCheckpoint = true;
  }
  if (sourceIndexFrom != null) o.sourceIndexFrom = sourceIndexFrom;
  if (sourceIndexTo != null) o.sourceIndexTo = sourceIndexTo;
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
  const skipNext = new Set(["--config", "--profile", "--migrate-run-mode", "--migrate-mode", "--source-key-range", "--source-key-from", "--source-key-to", "--source-index-range", "--source-index-from", "--source-index-to"]);
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
  const s = String(rangeStr).trim().toLowerCase();
  if (s === "all" || s === "*") return { from: null, to: null };
  const m = s.match(/^(\d+)\s*-\s*(\d+|all)$/);
  if (m) {
    return {
      from: Number.parseInt(m[1], 10),
      to: m[2] === "all" ? null : Number.parseInt(m[2], 10),
    };
  }
  const single = s.match(/^(\d+)$/);
  if (single) {
    const v = Number.parseInt(single[1], 10);
    return { from: v, to: v };
  }
  throw new Error(
    `--source-index-range ไม่ถูกต้อง "${rangeStr}" — ใช้รูป เช่น 1-100, 100-all, all`,
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
