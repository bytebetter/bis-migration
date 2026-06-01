import { batchIds, resolveMigrationSourceIds } from "./repairFromLog.mjs";
import { hasExplicitSourceIds } from "./sourceIdsSupport.mjs";

/**
 * @param {Record<string, unknown>} migration
 * @param {string} logsDir
 * @param {import("./migrateTableSpecs.mjs").RepairSpec} spec
 * @param {number} batchSize
 */
export function prepareExamIdRepair(migration, logsDir, spec, batchSize) {
  const repairSourceIds = resolveMigrationSourceIds(migration, logsDir, spec);
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

export function logExamIdRepairStart(tableKey, repair, migration = {}, spec = null) {
  if (!repair.active) return;
  const mode = hasExplicitSourceIds(migration)
    ? "by-source-ids"
    : "repair-from-log";
  if (repair.isEmpty) {
    console.error(`>>> [${tableKey}] ${mode}: ไม่มี id ให้ migrate`);
    return;
  }
  const idLabel = spec?.recordIdLabel ?? "id";
  console.error(
    `>>> [${tableKey}] migrateRunMode=${mode} (${repair.idCount} ${idLabel}, ${repair.batchCount} batches)`,
  );
}
