const EXAM_RECOMMEND_BIRADS45_COLUMNS = `
  CAST(CAST([Exam_ID] AS BIGINT) AS NVARCHAR(MAX)) AS exam_id,
  CONVERT(VARCHAR(30), [Exam_Date], 126) AS exam_date,
  CAST([PID] AS NVARCHAR(MAX)) AS pid,
  CAST(CAST([Recommend_ID] AS INT) AS NVARCHAR(MAX)) AS recommend_id,
  CAST([Biopsy_Procedure] AS NVARCHAR(MAX)) AS biopsy_procedure,
  CAST([Breast_Side] AS NVARCHAR(MAX)) AS breast_side,
  CAST([Location] AS NVARCHAR(MAX)) AS location
`.trim();

export const MSSQL_EXAM_RECOMMEND_BIRADS45_ID_SELECT = `
SELECT TOP (@page)
  CAST([Exam_ID] AS BIGINT) AS exam_id
FROM {{sourceObject}}
WHERE [Exam_ID] > @afterExamId
  AND (@migrateSrcKeyMin IS NULL OR CAST([Exam_ID] AS BIGINT) >= @migrateSrcKeyMin)
  AND (@migrateSrcKeyMax IS NULL OR CAST([Exam_ID] AS BIGINT) <= @migrateSrcKeyMax)
GROUP BY [Exam_ID]
ORDER BY [Exam_ID] ASC
`.trim();

export const MSSQL_EXAM_RECOMMEND_BIRADS45_DETAIL_BY_IDS_SELECT = `
SELECT
  ${EXAM_RECOMMEND_BIRADS45_COLUMNS}
FROM {{sourceObject}}
WHERE CAST([Exam_ID] AS BIGINT) IN ({{idPlaceholders}})
ORDER BY [Exam_ID] ASC, [Recommend_ID] ASC
`.trim();
