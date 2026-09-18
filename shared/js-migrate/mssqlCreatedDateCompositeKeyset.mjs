import { bracketMssqlIdent } from "./mssqlCreatedDateSort.mjs";

/**
 * examIdExpr / childExpr: ใช้ expression แทนคอลัมน์ได้ (เช่น CONVERT(BIGINT, [Exam_ID]))
 * — ต้องเป็นตัวเดียวกันทั้ง ORDER BY และ WHERE
 * @typedef {{ examIdExpr?: string, childExpr?: string }} ExamChildKeyExprs
 */

/** @param {string} childColumn @param {ExamChildKeyExprs} [opts] */
function examChildKeyExprs(childColumn, opts = {}) {
  return {
    examId: opts.examIdExpr ?? "[Exam_ID]",
    child: opts.childExpr ?? bracketMssqlIdent(childColumn),
  };
}

/**
 * composite column keyset — ใช้ index ได้ ไม่ scan ด้วย sortKeyExpr ใน WHERE
 * @param {string} createdDateColumn @param {string} childColumn @param {ExamChildKeyExprs} [opts]
 */
export function examChildCreatedDateOrderBy(createdDateColumn, childColumn, opts) {
  const cd = bracketMssqlIdent(createdDateColumn);
  const { examId, child } = examChildKeyExprs(childColumn, opts);
  const bucket = `CASE WHEN ${cd} IS NULL THEN 0 ELSE 1 END`;
  return `${bucket} ASC, ${cd} ASC, ${examId} ASC, ${child} ASC`;
}

/** @param {string} createdDateColumn @param {string} childColumn @param {ExamChildKeyExprs} [opts] */
export function examChildCreatedDateWhereClause(createdDateColumn, childColumn, opts) {
  const cd = bracketMssqlIdent(createdDateColumn);
  const { examId, child } = examChildKeyExprs(childColumn, opts);
  const bucket = `CASE WHEN ${cd} IS NULL THEN 0 ELSE 1 END`;
  // แยก bucket ชัดเจน — ห้ามใช้ bucket > @afterNullBucket ตอน afterNullBucket=0
  // (เคยดึงแถว bucket=1 ปนก่อนจบ bucket=0 แล้วข้ามแถวที่เหลือ)
  return `(
  @afterNullBucket < 0
  OR (
    @afterNullBucket = 0
    AND ${bucket} = 0
    AND (
      ${examId} > @afterExamId
      OR (${examId} = @afterExamId AND ${child} > @afterChildId)
    )
  )
  OR (
    @afterNullBucket = 1
    AND ${bucket} = 1
    AND (
      ${cd} > @afterCreatedDate
      OR (${cd} = @afterCreatedDate AND ${examId} > @afterExamId)
      OR (${cd} = @afterCreatedDate AND ${examId} = @afterExamId AND ${child} > @afterChildId)
    )
  )
)`.trim();
}

/** ไม่มี CreatedDate: เรียง (Exam_ID, child) @param {string} childColumn @param {ExamChildKeyExprs} [opts] */
export function examChildLegacyOrderBy(childColumn, opts) {
  const { examId, child } = examChildKeyExprs(childColumn, opts);
  return `${examId} ASC, ${child} ASC`;
}

/** @param {string} childColumn @param {ExamChildKeyExprs} [opts] */
export function examChildLegacyWhereClause(childColumn, opts) {
  const { examId, child } = examChildKeyExprs(childColumn, opts);
  return `(${examId} > @afterExamId OR (${examId} = @afterExamId AND ${child} > @afterChildId))`;
}

export function examIdOnlyCreatedDateOrderBy(createdDateColumn) {
  const cd = bracketMssqlIdent(createdDateColumn);
  const bucket = `CASE WHEN ${cd} IS NULL THEN 0 ELSE 1 END`;
  return `${bucket} ASC, ${cd} ASC, [Exam_ID] ASC`;
}

export function examIdOnlyCreatedDateWhereClause(createdDateColumn) {
  const cd = bracketMssqlIdent(createdDateColumn);
  const bucket = `CASE WHEN ${cd} IS NULL THEN 0 ELSE 1 END`;
  return `(
  @afterNullBucket < 0
  OR ${bucket} > @afterNullBucket
  OR (
    ${bucket} = @afterNullBucket
    AND (
      (@afterNullBucket = 0 AND [Exam_ID] > @afterExamId)
      OR (
        @afterNullBucket = 1 AND (
          ${cd} > @afterCreatedDate
          OR (${cd} = @afterCreatedDate AND [Exam_ID] > @afterExamId)
        )
      )
    )
  )
)`.trim();
}

/** @param {string} createdDateColumn @param {string} [tableAlias] */
export function createdDateSelectExpr(createdDateColumn, tableAlias = "") {
  const cd = bracketMssqlIdent(createdDateColumn);
  const prefix = tableAlias ? `${tableAlias}.` : "";
  return `CONVERT(VARCHAR(30), ${prefix}${cd}, 126) AS __created_date_mssql`;
}
