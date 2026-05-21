import { batchIds, resolveRepairSourceIds } from "./repairFromLog.mjs";

/**
 * @param {Record<string, unknown>} migration
 * @param {string} logsDir
 * @param {import("./migrateTableSpecs.mjs").RepairSpec} spec
 * @param {number} batchSize
 */
export function prepareExamIdRepair(migration, logsDir, spec, batchSize) {
  const repairSourceIds = resolveRepairSourceIds(migration, logsDir, spec);
  const repairBatches =
    repairSourceIds != null ? [...batchIds(repairSourceIds, batchSize)] : null;
  let repairBatchIndex = 0;
  return {
    active: repairSourceIds != null,
    isEmpty: repairSourceIds != null && repairSourceIds.length === 0,
    idCount: repairSourceIds?.length ?? 0,
    batchCount: repairBatches?.length ?? 0,
    plannedIds: repairSourceIds ?? null,
    notFoundInSource: repairSourceIds != null ? new Set() : null,
    takeNextBatch() {
      if (!repairBatches || repairBatchIndex >= repairBatches.length) return null;
      return repairBatches[repairBatchIndex++];
    },
    done() {
      return !repairBatches || repairBatchIndex >= repairBatches.length;
    },
  };
}

export function logExamIdRepairStart(tableKey, repair) {
  if (!repair.active) return;
  if (repair.isEmpty) {
    console.error(`>>> [${tableKey}] repair-from-log: ไม่มี id ให้ migrate`);
    return;
  }
  console.error(
    `>>> [${tableKey}] migrateRunMode=repair-from-log (${repair.idCount} exam_id, ${repair.batchCount} batches)`,
  );
}
