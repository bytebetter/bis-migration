/**
 * พารามิเตอร์ CLI ร่วมสำหรับงาน migrate (แชร์ข้าม profile)
 *
 * --migrate-mode overwrite | insert-only
 *    overwrite     = พฤติกรรมเดิม (อัปเดตของที่มีอยู่ / เติมแถวใหม่)
 *    insert-only   = เพิ่มเฉพาะแถวที่ยังไม่มีใน Postgres (ข้ามอัปเดตของเดิม)
 *
 * ช่วงคีย์ต้นทาง (เลขทั้งชุดInclusive, เช่น Schedule_ID / Exam_ID):
 *    --source-key-range 1-100
 *    หรือ --source-key-from 1 --source-key-to 100
 */

/**
 * @param {string[]} argv
 * @returns {{
 *   migrateRowMode: 'overwrite' | 'insert-only',
 *   sourceKeyMin: bigint | null,
 *   sourceKeyMax: bigint | null,
 *   rawArgvTail: string[]
 * }}
 */
export function parseMigrateCliArgs(argv = process.argv) {
  const migrateModeRaw = argvValue(argv, "--migrate-mode");
  const migrateRowMode =
    migrateModeRaw === "insert-only" ? "insert-only" : "overwrite";

  let sourceKeyMin = parseOptionalBig(argvValue(argv, "--source-key-from"));
  let sourceKeyMax = parseOptionalBig(argvValue(argv, "--source-key-to"));
  const rangeStr = argvValue(argv, "--source-key-range");
  if (rangeStr != null) {
    const m = String(rangeStr).trim().match(/^(-?\d+)\s*-\s*(-?\d+)$/);
    if (!m) {
      throw new Error(
        `--source-key-range ไม่ถูกต้อง "${rangeStr}" — ใช้รูป เช่น 1-100`,
      );
    }
    sourceKeyMin = BigInt(m[1]);
    sourceKeyMax = BigInt(m[2]);
  }
  if (sourceKeyMin != null && sourceKeyMax != null && sourceKeyMin > sourceKeyMax) {
    throw new Error(
      `--source-key-from ต้องไม่เกิน --source-key-to (${sourceKeyMin} > ${sourceKeyMax})`,
    );
  }

  /** ส่วนที่เหลือส่งให้ npm/node ได้ (ว่างในเวอร์ชันนี้) */
  const rawArgvTail = [];
  return { migrateRowMode, sourceKeyMin, sourceKeyMax, rawArgvTail };
}

export function migrateCliOverridesFromArgv(argv = process.argv) {
  const { migrateRowMode, sourceKeyMin, sourceKeyMax } = parseMigrateCliArgs(
    argv,
  );
  /** @type {Record<string, unknown>} */
  const o = {};
  o.migrateRowMode = migrateRowMode;
  if (sourceKeyMin != null)
    o.sourceKeyNumericMin = sourceKeyMin.toString();
  if (sourceKeyMax != null)
    o.sourceKeyNumericMax = sourceKeyMax.toString();
  return o;
}

/**
 * เข้ากับ `{ ...config.migration, ...migrateCliOverridesFromArgv() }`
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

function parseOptionalBig(s) {
  if (s == null || String(s).trim() === "") return null;
  try {
    return BigInt(String(s).trim());
  } catch {
    throw new Error(`ค่าไม่ใช่เลขเต็ม: ${JSON.stringify(s)}`);
  }
}
