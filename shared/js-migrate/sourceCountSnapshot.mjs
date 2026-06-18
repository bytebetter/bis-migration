/**
 * Snapshot จำนวนแถวต้นทางก่อน migrate:all
 *
 * Flow:
 * 1. migrate:all เรียก --count-only → ได้จำนวนเต็ม ณ ตอนนั้น (##SOURCE_COUNT##)
 * 2. ส่ง --source-count-cap ต่อตาราง (ไม่ใช้ sourceIndexTo — ไม่เปลี่ยนชื่อ checkpoint)
 * 3. migrate จริง: plannedRows = min(live COUNT, cap) − offset จาก checkpoint เดิม
 */

import {
  hasMigrateRowWindow,
  narrowPlannedRowsForIndex,
  readSourceCountCap,
} from "./sourceIndexRange.mjs";

export { hasMigrateRowWindow, readSourceCountCap };

/** บรรทัด sentinel ที่ orchestrator parse เอาตัวเลข */
export const SOURCE_COUNT_SENTINEL = "##SOURCE_COUNT##";

/**
 * @param {string[]} [argv]
 */
export function isCountOnlyRun(argv = process.argv) {
  return argv.includes("--count-only");
}

/** รอบ --count-only ไม่ควรเขียน checkpoint / reset target */
export function shouldSkipMigrateSideEffects(argv = process.argv) {
  return isCountOnlyRun(argv);
}

/**
 * @param {number | null | undefined} count
 */
export function emitSourceCountAndExit(count) {
  const n =
    count == null || !Number.isFinite(Number(count)) ? "null" : String(count);
  process.stdout.write(`${SOURCE_COUNT_SENTINEL} ${n}\n`);
  process.exit(0);
}

/**
 * snapshot count-only → พิมพ์จำนวนเต็ม (ก่อน cap) แล้ว exit
 * @param {number | null | undefined} sourceRowCountTotal
 */
export function maybeEmitSourceCount(sourceRowCountTotal) {
  if (isCountOnlyRun()) emitSourceCountAndExit(sourceRowCountTotal);
}

/**
 * จำกัดแถวที่จะ migrate ตาม snapshot cap / index range — ไม่กระทบชื่อ checkpoint
 * @param {{
 *   migrationConfig: Record<string, unknown> | null | undefined,
 *   sourceRowCountTotal: number | null | undefined,
 *   offset: number,
 *   indexLimited?: boolean,
 *   sourceIndexFrom?: number | null,
 *   sourceIndexTo?: number | null,
 * }} p
 * @returns {number | null}
 */
export function plannedRowsWithSnapshotCap(p) {
  const {
    migrationConfig,
    sourceRowCountTotal,
    offset,
    indexLimited = false,
    sourceIndexFrom = null,
    sourceIndexTo = null,
  } = p;
  if (sourceRowCountTotal == null) return null;
  if (!hasMigrateRowWindow(migrationConfig, indexLimited)) {
    return sourceRowCountTotal;
  }
  return narrowPlannedRowsForIndex({
    plannedRows: sourceRowCountTotal,
    offset,
    sourceIndexFrom,
    sourceIndexTo,
    migrationConfig,
  });
}

/**
 * count-only + cap plan ในคำสั่งเดียว (เรียงถูก: emit จำนวนเต็มก่อน narrow)
 * @param {Parameters<typeof plannedRowsWithSnapshotCap>[0]} p
 * @returns {number | null} plannedRows หลัง cap (สำหรับ progress / loop)
 */
export function prepareMigrateRowPlan(p) {
  maybeEmitSourceCount(p.sourceRowCountTotal);
  const cap = readSourceCountCap(p.migrationConfig);
  if (cap != null && !isCountOnlyRun()) {
    console.error(`>>> snapshot sourceCountCap=${cap} (ล็อกจำนวน sync ตาม snapshot — checkpoint ชื่อเดิม)`);
  }
  return plannedRowsWithSnapshotCap(p);
}
