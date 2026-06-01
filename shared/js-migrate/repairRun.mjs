import { plannedProgressForSourceIds } from "./sourceIdsSupport.mjs";
import {
  logExamIdRepairStart,
  prepareExamIdRepair,
} from "./examIdRepair.mjs";
import {
  finalizeRepairFromLog,
  noteRepairBatchNotFoundInSource,
} from "./repairSummary.mjs";

/** @typedef {ReturnType<typeof prepareExamIdRepair>} RepairRun */

export function prepareRepairRun(migration, logsDir, spec, batchSize) {
  const repair = prepareExamIdRepair(migration, logsDir, spec, batchSize);
  logExamIdRepairStart(spec.tableLabel, repair, migration, spec);
  return repair;
}

/** @param {RepairRun} repair @param {number} batchSize */
export function explicitIdsProgressPlan(repair, batchSize) {
  if (!repair?.active || !repair.plannedIds?.length) return null;
  return plannedProgressForSourceIds(repair.plannedIds, batchSize);
}

export function repairRunIsEmpty(repair) {
  return repair.isEmpty;
}

export function repairRunIsDone(repair) {
  return repair.done();
}

export function takeNextRepairBatch(repair) {
  return repair.takeNextBatch();
}

/**
 * @param {RepairRun} repair
 * @param {string[]} idBatch
 * @param {object[]} rows
 * @param {(row: object) => string} getIdFromRow
 */
export function noteRepairBatchFetch(repair, idBatch, rows, getIdFromRow) {
  if (!repair?.active || !repair.notFoundInSource) return;
  noteRepairBatchNotFoundInSource(
    repair.notFoundInSource,
    idBatch,
    rows,
    getIdFromRow,
  );
}

/**
 * @param {string} tableKey
 * @param {import("./migrateTableSpecs.mjs").RepairSpec} spec
 * @param {RepairRun} repair
 * @param {object} [options]
 * @param {Iterable<string>} [options.failedIds]
 * @param {import("./fieldIssueLog.mjs").FieldIssueAccumulator | null} [options.fieldIssueAcc]
 * @returns {import("./repairSummary.mjs").buildRepairRunSummary extends (...args: never[]) => infer R ? R : never | null}
 */
export function finishRepairRunSummary(tableKey, spec, repair, options = {}) {
  if (!repair?.active || !repair.plannedIds) return null;
  return finalizeRepairFromLog(tableKey, spec, repair.plannedIds, {
    notFoundInSourceIds: repair.notFoundInSource,
    failedIds: options.failedIds,
    fieldIssueAcc: options.fieldIssueAcc ?? null,
  });
}
