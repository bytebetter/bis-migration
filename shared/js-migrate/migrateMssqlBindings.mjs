import {
  bindMigrateSrcNumericRange,
  readNumericSourceKeyBounds,
} from "./migrateCliArgs.mjs";

/** ผูก @appointmentDtFrom / @appointmentDtToExcl เป็น NULL และช่วงคีย์ตัวเลข (ถ้ามี) */
export function bindAppointmentMssqlCommon(req, migration, sqlPkg) {
  req.input("appointmentDtFrom", sqlPkg.DateTime, null);
  req.input("appointmentDtToExcl", sqlPkg.DateTime, null);
  bindMigrateSrcNumericRange(req, migration, sqlPkg);
}

export function appointmentScheduleNumericRangePredicate(
  numericExprForScheduleId,
) {
  return `(@migrateSrcKeyMin IS NULL OR ${numericExprForScheduleId} >= @migrateSrcKeyMin)
  AND (@migrateSrcKeyMax IS NULL OR ${numericExprForScheduleId} <= @migrateSrcKeyMax)`;
}

/** ช่วง [Exam_ID] แบบ BIGINT */
export function examinationExamNumericRangePredicate() {
  const e = `CAST([Exam_ID] AS BIGINT)`;
  return `(@migrateSrcKeyMin IS NULL OR ${e} >= @migrateSrcKeyMin)
  AND (@migrateSrcKeyMax IS NULL OR ${e} <= @migrateSrcKeyMax)`;
}

export function hasNumericSourceRange(migration) {
  const { min, max } = readNumericSourceKeyBounds(migration);
  return min != null || max != null;
}
