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
export function readSourceCountCap(migrationConfig) {
  return readPositiveIndex(migrationConfig?.sourceCountCap);
}

/** มีเพดานแถวจาก index range หรือ snapshot count cap (migrate:all) */
export function hasMigrateRowWindow(migrationConfig, indexLimited) {
  return indexLimited || readSourceCountCap(migrationConfig) != null;
}

/** plannedRows สำหรับ resolvePageSize — ใช้เมื่อมี snapshot cap หรือ index range */
export function plannedRowsForPageSize(
  plannedRows,
  migrationConfig,
  indexLimited,
) {
  if (plannedRows == null) return null;
  return hasMigrateRowWindow(migrationConfig, indexLimited) ? plannedRows : null;
}

/**
 * แถวที่ migrate ในรอบ job นี้ (ไม่ใช่ offset สะสมจาก checkpoint)
 * plannedRows จาก narrowPlannedRowsForIndex = จำนวนที่เหลือในรอบนี้
 */
export function rowsDoneInMigrateRun(currentOffset, runStartOffset) {
  return Math.max(0, currentOffset - runStartOffset);
}

/**
 * mark checkpoint completed เมื่อครบแผนในรอบนี้ — กัน resume+sourceCountCap ที่ไม่ได้ process แถว
 */
export function shouldMarkMigrateCheckpointComplete(p) {
  const {
    migrationConfig,
    indexLimited,
    runStartOffset,
    currentOffset,
    plannedRows,
  } = p;
  if (!hasMigrateRowWindow(migrationConfig, indexLimited)) return true;
  if (plannedRows == null || plannedRows <= 0) return true;
  return rowsDoneInMigrateRun(currentOffset, runStartOffset) >= plannedRows;
}

/**
 * ตัดแถวหลัง fetch ให้ไม่เกิน snapshot cap (ล็อกจำนวน ณ ตอน migrate:all)
 * @template T
 * @param {T[]} rows
 * @returns {T[]}
 */
export function trimRowsToMigrateCap(
  rows,
  totalBeforeChunk,
  plannedRows,
  migrationConfig,
  indexLimited,
) {
  if (!hasMigrateRowWindow(migrationConfig, indexLimited) || plannedRows == null) {
    return rows;
  }
  const remain = plannedRows - totalBeforeChunk;
  if (remain <= 0) return [];
  if (rows.length <= remain) return rows;
  return rows.slice(0, remain);
}

/** จำกัด keyset advance ไม่ให้เกิน cap ที่เหลือ */
export function capAdvanceToMigratePlan(
  advance,
  totalBeforeChunk,
  plannedRows,
  migrationConfig,
  indexLimited,
) {
  if (!hasMigrateRowWindow(migrationConfig, indexLimited) || plannedRows == null) {
    return advance;
  }
  const remain = plannedRows - totalBeforeChunk;
  if (remain <= 0) return 0;
  return Math.min(advance, remain);
}

export function narrowPlannedRowsForIndex(p) {
  const {
    offset,
    sourceIndexFrom,
    sourceIndexTo,
    sourceCountCap: capArg,
    migrationConfig,
  } = p;
  let { plannedRows } = p;
  if (plannedRows == null) return null;
  const sourceCountCap =
    capArg ?? readSourceCountCap(migrationConfig ?? null);
  let effectiveFrom = offset + 1;
  if (sourceIndexFrom != null) {
    effectiveFrom = Math.max(effectiveFrom, sourceIndexFrom);
  }
  let effectiveTo = plannedRows;
  // snapshot cap จาก migrate:all = เพดานแถวที่ต้อง sync ไม่ใช่ min กับ COUNT สด
  if (sourceCountCap != null) {
    effectiveTo = sourceCountCap;
  } else if (sourceIndexTo != null) {
    effectiveTo = Math.min(effectiveTo, sourceIndexTo);
  }
  return effectiveTo >= effectiveFrom ? effectiveTo - effectiveFrom + 1 : 0;
}

/**
 * จำนวนแถวต้นทางที่ต้องอ่านให้ครบ (ใช้ตรวจหลัง migrate)
 */
export function readMigrationTargetRowCount(
  migrationConfig,
  indexLimited,
  progressTotal,
  plannedRows,
) {
  const cap = readSourceCountCap(migrationConfig);
  if (cap != null) return cap;
  if (!hasMigrateRowWindow(migrationConfig, indexLimited)) return null;
  return progressTotal ?? plannedRows ?? null;
}

/** โยน error เมื่อมี cap/index window แต่อ่านไม่ครบ — กัน migrate:all ขึ้น OK ทั้งที่ข้อมูลขาด */
export function assertMigrationReachedPlan(p) {
  const {
    tableKey,
    currentOffset,
    migrationConfig,
    indexLimited,
    progressTotal,
    plannedRows,
    sourceExhausted = false,
  } = p;
  const target = readMigrationTargetRowCount(
    migrationConfig,
    indexLimited,
    progressTotal,
    plannedRows,
  );
  if (target == null || target <= 0) return;
  if (currentOffset >= target) return;
  // keyset อ่านจนสุดตารางต้นทางแล้ว (MSSQL คืน 0 แถว) — อ่านครบทุกแถวที่มีอยู่จริง
  // snapshot cap มาจาก NOLOCK COUNT ของ live DB ซึ่งแกว่ง/นับเกินได้ จึงต่ำกว่า cap ได้โดยไม่ใช่ข้อมูลขาด
  if (sourceExhausted) {
    console.error(
      `>>> [${tableKey}] อ่านครบต้นทาง: ${currentOffset} แถว (snapshot cap=${target} ` +
        `ต่างเพราะ source เป็น live NOLOCK ที่ count แกว่ง) — ถือว่าสำเร็จ`,
    );
    return;
  }
  throw new Error(
    `[${tableKey}] migrate ไม่ครบต้นทาง: อ่านได้ ${currentOffset}/${target} แถว — ` +
      `ลบ checkpoint ใน js-migrate/checkpoints/ แล้วรันใหม่ ` +
      `(หรือ -MigrateRunMode overwrite)`,
  );
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
  const { indexLimited, plannedRows, rowsReadInWindow, migrationConfig } = p;
  const windowLimited = hasMigrateRowWindow(migrationConfig, indexLimited);
  if (!windowLimited || plannedRows == null) return false;
  return rowsReadInWindow >= plannedRows;
}

/**
 * หยุด loop migrate หรือยัง — เมื่อมี snapshot cap / index range อย่าหยุดแค่เพราะ advance < pageSize
 * (ยังมีแถวในแผนเหลือ) ให้หยุดเมื่อ advance <= 0 (MSSQL ไม่ส่งแถวแล้ว) หรือครบ plannedRows
 */
export function shouldStopMigratePagination({
  advance,
  pageSize,
  rowsReadInWindow,
  plannedRows,
  migrationConfig,
  indexLimited,
  repairDone = false,
}) {
  if (repairDone) return true;
  if (
    isIndexWindowComplete({
      indexLimited,
      migrationConfig,
      plannedRows,
      rowsReadInWindow,
    })
  ) {
    return true;
  }
  if (hasMigrateRowWindow(migrationConfig, indexLimited)) {
    return (advance ?? 0) <= 0;
  }
  // มี plannedRows จาก COUNT — อย่าหยุดแค่เพราะ advance < pageSize ถ้ายังไม่ครบแผน
  if (plannedRows != null && rowsReadInWindow < plannedRows) {
    return (advance ?? 0) <= 0;
  }
  return (advance ?? 0) < pageSize;
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
