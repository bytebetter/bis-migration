/**
 * dbo.EXAM_Recommend_BIRADS45 — 1 exam มีได้หลายแถว (Recommend_ID)
 * probe ดึง Exam_ID ไม่ซ้ำเรียงตามเลข → detail ดึงทุกแถวของ exam เหล่านั้น
 * (ใช้ expression เดียวกันทั้ง WHERE / GROUP BY / ORDER BY ให้ keyset ไม่ข้ามแถว)
 */
const EXAM_ID_EXPR = "CAST([Exam_ID] AS BIGINT)";

const EXAM_RECOMMEND_BIRADS45_COLUMNS = `
  CAST(CAST([Exam_ID] AS BIGINT) AS NVARCHAR(MAX)) AS exam_id,
  CONVERT(VARCHAR(30), [Exam_Date], 126) AS exam_date,
  CAST([PID] AS NVARCHAR(MAX)) AS pid,
  CAST(CAST([Recommend_ID] AS INT) AS NVARCHAR(MAX)) AS recommend_id,
  CAST([Biopsy_Procedure] AS NVARCHAR(MAX)) AS biopsy_procedure,
  CAST([Breast_Side] AS NVARCHAR(MAX)) AS breast_side,
  CAST([Location] AS NVARCHAR(MAX)) AS location
`.trim();

/** หน้า Exam_ID ถัดจาก @afterExamId — GROUP BY ให้ 1 แถวต่อ exam (ตัวนับ/แผน = จำนวน exam) */
export const MSSQL_EXAM_RECOMMEND_BIRADS45_ID_SELECT = `
SELECT TOP (@page)
  ${EXAM_ID_EXPR} AS exam_id
FROM {{sourceObject}}
WHERE ${EXAM_ID_EXPR} > @afterExamId
  AND (@migrateSrcKeyMin IS NULL OR ${EXAM_ID_EXPR} >= @migrateSrcKeyMin)
  AND (@migrateSrcKeyMax IS NULL OR ${EXAM_ID_EXPR} <= @migrateSrcKeyMax)
GROUP BY ${EXAM_ID_EXPR}
ORDER BY ${EXAM_ID_EXPR} ASC
`.trim();

export const MSSQL_EXAM_RECOMMEND_BIRADS45_DETAIL_BY_IDS_SELECT = `
SELECT
  ${EXAM_RECOMMEND_BIRADS45_COLUMNS}
FROM {{sourceObject}}
WHERE ${EXAM_ID_EXPR} IN ({{idPlaceholders}})
ORDER BY ${EXAM_ID_EXPR} ASC, [Recommend_ID] ASC
`.trim();
