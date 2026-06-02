/**
 * ช่วงลำดับแถวต้นทาง (1-based, inclusive) ตาม ORDER BY ของงาน migrate
 * ไม่ใช่การกรองตามค่า key (PID / Schedule_ID / Exam_ID)
 */

/**
 * @param {unknown} v
 * @returns {number | null}
 */
export function readPositiveIndex(v) {
  if (v == null || String(v).trim() === "") return null;
  const n = Number.parseInt(String(v).trim(), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

/**
 * @param {Record<string, unknown>} migrationConfig
 */
export function readSourceIndexBounds(migrationConfig) {
  const sourceIndexFrom = readPositiveIndex(migrationConfig?.sourceIndexFrom);
  const sourceIndexTo = readPositiveIndex(migrationConfig?.sourceIndexTo);
  const indexStartOffset = sourceIndexFrom != null ? sourceIndexFrom - 1 : 0;
  const indexLimited = sourceIndexFrom != null || sourceIndexTo != null;
  return {
    sourceIndexFrom,
    sourceIndexTo,
    indexStartOffset,
    indexLimited,
  };
}

/**
 * @param {Record<string, unknown>} migrationConfig
 */
export function buildIndexCheckpointSuffix(migrationConfig) {
  const { sourceIndexFrom, sourceIndexTo, indexLimited } =
    readSourceIndexBounds(migrationConfig);
  if (!indexLimited) return "";
  const from = sourceIndexFrom == null ? "all" : String(sourceIndexFrom);
  const to = sourceIndexTo == null ? "all" : String(sourceIndexTo);
  return `-i-${from}-${to}`;
}

/**
 * @param {string} key
 * @param {Record<string, unknown>} migrationConfig
 */
export function logSourceIndexRangeIfSet(key, migrationConfig) {
  const { sourceIndexFrom, sourceIndexTo, indexLimited } =
    readSourceIndexBounds(migrationConfig);
  if (!indexLimited) return;
  const from = sourceIndexFrom == null ? "all" : String(sourceIndexFrom);
  const to = sourceIndexTo == null ? "all" : String(sourceIndexTo);
  console.error(
    `>>> [${key}] sourceIndexRange: ${from}-${to} (แถวลำดับตาม ORDER BY, 1-based inclusive)`,
  );
}

function isRepairFromLogRun(migrationConfig) {
  return (
    String(migrationConfig?.migrateRunMode ?? "").toLowerCase() ===
    "repair-from-log"
  );
}

/**
 * @param {{
 *   offset: number,
 *   checkpointEnabled: boolean,
 *   migrationConfig: Record<string, unknown>,
 *   indexLimited: boolean,
 *   indexStartOffset: number,
 * }} p
 */
export function applySourceIndexOffset(p) {
  const { checkpointEnabled, migrationConfig, indexLimited, indexStartOffset } =
    p;
  let { offset } = p;
  if (!indexLimited || isRepairFromLogRun(migrationConfig)) return offset;
  if (checkpointEnabled) {
    offset = Math.max(offset, indexStartOffset);
  } else {
    offset = indexStartOffset;
  }
  return offset;
}

/**
 * เมื่อข้ามแถวต้นๆ (index > 1) ต้องใช้ OFFSET — keyset นับจาก key ไม่ใช่ลำดับแถว
 *
 * @param {{
 *   useMssqlKeyset: boolean,
 *   indexLimited: boolean,
 *   indexStartOffset: number,
 *   key: string,
 * }} p
 */
export function disableKeysetForSourceIndex(p) {
  const { indexLimited, indexStartOffset, key } = p;
  let { useMssqlKeyset } = p;
  if (!indexLimited || indexStartOffset <= 0) return useMssqlKeyset;
  if (useMssqlKeyset) {
    console.error(
      `>>> [${key}] sourceIndexRange: ใช้ OFFSET (ข้าม ${indexStartOffset} แถวแรกตาม ORDER BY)`,
    );
  }
  return false;
}

/**
 * @param {{
 *   plannedRows: number | null,
 *   offset: number,
 *   sourceIndexFrom: number | null,
 *   sourceIndexTo: number | null,
 * }} p
 */
export function narrowPlannedRowsForIndex(p) {
  const { offset, sourceIndexFrom, sourceIndexTo } = p;
  let { plannedRows } = p;
  if (plannedRows == null) return null;
  let effectiveFrom = offset + 1;
  if (sourceIndexFrom != null) {
    effectiveFrom = Math.max(effectiveFrom, sourceIndexFrom);
  }
  let effectiveTo = plannedRows;
  if (sourceIndexTo != null) {
    effectiveTo = Math.min(effectiveTo, sourceIndexTo);
  }
  return effectiveTo >= effectiveFrom ? effectiveTo - effectiveFrom + 1 : 0;
}

/**
 * @param {{
 *   batchSize: number,
 *   total: number,
 *   sourceLimit?: number | null,
 *   plannedRows?: number | null,
 * }} p
 */
export function resolvePageSize(p) {
  const { batchSize, total, sourceLimit = null, plannedRows = null } = p;
  let remaining = sourceLimit == null ? null : sourceLimit - total;
  if (plannedRows != null) {
    const indexRemaining = plannedRows - total;
    remaining =
      remaining == null
        ? indexRemaining
        : Math.min(remaining, indexRemaining);
  }
  if (remaining != null && remaining <= 0) return 0;
  return remaining == null ? batchSize : Math.min(batchSize, remaining);
}

/**
 * @param {{
 *   indexLimited: boolean,
 *   plannedRows: number | null,
 *   rowsReadInWindow: number,
 * }} p
 */
export function isIndexWindowComplete(p) {
  const { indexLimited, plannedRows, rowsReadInWindow } = p;
  if (!indexLimited || plannedRows == null) return false;
  return rowsReadInWindow >= plannedRows;
}

/**
 * รวม offset + keyset + log หลังอ่าน checkpoint
 *
 * @param {{
 *   key: string,
 *   migrationConfig: Record<string, unknown>,
 *   checkpointEnabled: boolean,
 *   offset: number,
 *   useMssqlKeyset?: boolean,
 * }} p
 */
export function applySourceIndexToMigrateJob(p) {
  const idx = readSourceIndexBounds(p.migrationConfig);
  logSourceIndexRangeIfSet(p.key, p.migrationConfig);
  const offset = applySourceIndexOffset({
    offset: p.offset,
    checkpointEnabled: p.checkpointEnabled,
    migrationConfig: p.migrationConfig,
    ...idx,
  });
  const useMssqlKeyset = disableKeysetForSourceIndex({
    useMssqlKeyset: p.useMssqlKeyset !== false,
    key: p.key,
    ...idx,
  });
  return { ...idx, offset, useMssqlKeyset };
}
