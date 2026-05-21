/**
 * สรุปผลโหมด repair-from-log: จำนวนจาก log / สำเร็จ / ไม่สำเร็จ
 */

/**
 * @param {string[]} plannedIds
 * @param {object} options
 * @param {Iterable<string>} [options.failedIds]
 * @param {Iterable<string>} [options.notFoundInSourceIds]
 * @param {import("./fieldIssueLog.mjs").FieldIssueAccumulator | null} [options.fieldIssueAcc]
 * @param {string} [options.fieldIssueRecordIdKey]
 */
export function buildRepairRunSummary(plannedIds, options = {}) {
  const planned = [...new Set(plannedIds.map((id) => String(id).trim()).filter(Boolean))];
  /** @type {Set<string>} */
  const failed = new Set();
  /** @type {Set<string>} */
  const notFound = new Set();

  for (const id of options.failedIds ?? []) {
    const s = String(id).trim();
    if (s) failed.add(s);
  }
  for (const id of options.notFoundInSourceIds ?? []) {
    const s = String(id).trim();
    if (s) notFound.add(s);
  }

  const acc = options.fieldIssueAcc;
  if (acc?.recordsById?.size) {
    for (const id of acc.recordsById.keys()) {
      const s = String(id).trim();
      if (s) failed.add(s);
    }
  }

  for (const id of notFound) {
    if (!failed.has(id)) failed.add(id);
  }

  const plannedSet = new Set(planned);
  const succeededIds = planned.filter((id) => !failed.has(id));
  const failedIds = planned.filter((id) => failed.has(id));
  const notFoundInSourceIds = [...notFound].filter((id) => plannedSet.has(id));

  return {
    plannedCount: planned.length,
    successCount: succeededIds.length,
    failCount: failedIds.length,
    notFoundInSourceCount: notFoundInSourceIds.length,
    mappingOrPgFailCount: Math.max(0, failedIds.length - notFoundInSourceIds.length),
    succeededIds,
    failedIds,
    notFoundInSourceIds,
  };
}

/**
 * @param {string} tableKey
 * @param {{ tableLabel?: string, recordIdLabel?: string }} spec
 * @param {ReturnType<typeof buildRepairRunSummary>} summary
 */
export function logRepairRunSummary(tableKey, spec, summary) {
  const label = spec.recordIdLabel ?? "id";
  const name = spec.tableLabel ?? tableKey;
  console.error(
    `>>> [${tableKey}] repair-from-log สรุปผล (${name}): จาก log ต้องแก้ ${summary.plannedCount} รายการ (${label})`,
  );
  console.error(
    `>>> [${tableKey}]   สำเร็จ: ${summary.successCount} เคส`,
  );
  console.error(
    `>>> [${tableKey}]   ไม่สำเร็จ: ${summary.failCount} เคส`,
  );
  if (summary.notFoundInSourceCount > 0) {
    console.error(
      `>>> [${tableKey}]     - ไม่พบใน MSSQL: ${summary.notFoundInSourceCount} เคส`,
    );
  }
  if (summary.mappingOrPgFailCount > 0) {
    console.error(
      `>>> [${tableKey}]     - แมป/ลง Postgres ไม่ผ่าน: ${summary.mappingOrPgFailCount} เคส`,
    );
  }
  if (summary.failedIds.length > 0 && summary.failedIds.length <= 20) {
    console.error(
      `>>> [${tableKey}]   รายการไม่สำเร็จ: ${summary.failedIds.join(", ")}`,
    );
  } else if (summary.failedIds.length > 20) {
    console.error(
      `>>> [${tableKey}]   รายการไม่สำเร็จ (20 แรก): ${summary.failedIds.slice(0, 20).join(", ")} ... (+${summary.failedIds.length - 20})`,
    );
  }
}

/**
 * @param {string} tableKey
 * @param {{ recordIdLabel?: string, tableLabel?: string }} spec
 * @param {string[] | null} plannedIds
 * @param {object} options
 * @returns {ReturnType<typeof buildRepairRunSummary> | null}
 */
export function finalizeRepairFromLog(tableKey, spec, plannedIds, options = {}) {
  if (plannedIds == null) return null;
  const summary = buildRepairRunSummary(plannedIds, options);
  logRepairRunSummary(tableKey, spec, summary);
  return summary;
}

/**
 * บันทึก id ใน batch ที่ดึงจาก MSSQL ไม่เจอ
 * @param {Set<string>} notFoundSet
 * @param {string[]} batchIds
 * @param {object[]} rows
 * @param {(row: object) => string} getIdFromRow
 */
export function noteRepairBatchNotFoundInSource(
  notFoundSet,
  batchIds,
  rows,
  getIdFromRow,
) {
  const found = new Set(
    rows.map(getIdFromRow).map((id) => String(id).trim()).filter(Boolean),
  );
  for (const id of batchIds) {
    const s = String(id).trim();
    if (s && !found.has(s)) notFoundSet.add(s);
  }
}
