import { bracketMssqlIdent } from "./mssqlCreatedDateSort.mjs";

/** composite column keyset — ใช้ index ได้ ไม่ scan ด้วย sortKeyExpr ใน WHERE */
export function examChildCreatedDateOrderBy(createdDateColumn, childColumn) {
  const cd = bracketMssqlIdent(createdDateColumn);
  const child = bracketMssqlIdent(childColumn);
  const bucket = `CASE WHEN ${cd} IS NULL THEN 0 ELSE 1 END`;
  return `${bucket} ASC, ${cd} ASC, [Exam_ID] ASC, ${child} ASC`;
}

export function examChildCreatedDateWhereClause(createdDateColumn, childColumn) {
  const cd = bracketMssqlIdent(createdDateColumn);
  const child = bracketMssqlIdent(childColumn);
  const bucket = `CASE WHEN ${cd} IS NULL THEN 0 ELSE 1 END`;
  // แยก bucket ชัดเจน — ห้ามใช้ bucket > @afterNullBucket ตอน afterNullBucket=0
  // (เคยดึงแถว bucket=1 ปนก่อนจบ bucket=0 แล้วข้ามแถวที่เหลือ)
  return `(
  @afterNullBucket < 0
  OR (
    @afterNullBucket = 0
    AND ${bucket} = 0
    AND (
      [Exam_ID] > @afterExamId
      OR ([Exam_ID] = @afterExamId AND ${child} > @afterChildId)
    )
  )
  OR (
    @afterNullBucket = 1
    AND ${bucket} = 1
    AND (
      ${cd} > @afterCreatedDate
      OR (${cd} = @afterCreatedDate AND [Exam_ID] > @afterExamId)
      OR (${cd} = @afterCreatedDate AND [Exam_ID] = @afterExamId AND ${child} > @afterChildId)
    )
  )
)`.trim();
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
