/**
 * Two-step MSSQL fetch: probe TOP @page keys แล้ว detail WHERE IN (...).
 * แถวจาก detail อาจมากกว่า probe เมื่อต้นทางมีหลายแถวต่อคีย์เดียว —
 * progress / checkpoint offset ต้องนับตาม probe ไม่ใช่ rows.length จาก detail.
 */

/**
 * @param {number|null|undefined} probeCount จำนวนคีย์จาก id probe (หรือ null ถ้าไม่ใช่ two-step)
 * @param {number} detailRowCount จำนวนแถวจาก detail / single query
 */
export function resolveKeysetAdvance(probeCount, detailRowCount) {
  if (probeCount != null && probeCount > 0) return probeCount;
  return detailRowCount;
}

/** @param {number} advance */
export function isLastKeysetPage(advance, pageSize) {
  return advance < pageSize;
}

/** @param {number} advance @param {number} detailRowCount */
export function optionalDetailRowCount(advance, detailRowCount) {
  if (detailRowCount === advance) return {};
  return { detailRowCount };
}

/** @param {number} advance @param {number} detailRowCount */
export function formatAdvanceLog(advance, detailRowCount) {
  if (detailRowCount === advance) return `${advance} rows`;
  return `${advance} rows advanced (${detailRowCount} detail rows)`;
}
