const ULTRASOUND_CYST_STAGING_COLUMNS = `
  [Described_Cyst_ID],
  [Exam_ID],
  [Exam_Date],
  [PID],
  [Echo_Pattern],
  [Echo_Pattern_Des],
  [Shape],
  [Shape_Des],
  [Size_Width],
  [Size_Depth],
  [Wall_Margin],
  [Wall_Margin_Des],
  [Solid_Component],
  [r_Position],
  [r_Position_Des],
  [l_Position],
  [l_Position_Des],
  [l_Position_Clock],
  [r_Position_Clock]
`.trim();

const ULTRASOUND_CYST_COLUMNS = `
  CAST(s.[Described_Cyst_ID] AS NVARCHAR(MAX)) AS described_cyst_id,
  CAST(CAST(s.[Exam_ID] AS BIGINT) AS NVARCHAR(MAX)) AS exam_id,
  CONVERT(VARCHAR(30), s.[Exam_Date], 126) AS exam_date,
  CAST(s.[PID] AS NVARCHAR(MAX)) AS pid,
  CAST(s.[Echo_Pattern] AS NVARCHAR(MAX)) AS echo_pattern,
  CAST(s.[Echo_Pattern_Des] AS NVARCHAR(MAX)) AS echo_pattern_des,
  CAST(s.[Shape] AS NVARCHAR(MAX)) AS shape,
  CAST(s.[Shape_Des] AS NVARCHAR(MAX)) AS shape_des,
  CAST(s.[Size_Width] AS NVARCHAR(MAX)) AS size_width,
  CAST(s.[Size_Depth] AS NVARCHAR(MAX)) AS size_depth,
  CAST(s.[Wall_Margin] AS NVARCHAR(MAX)) AS wall_margin,
  CAST(s.[Wall_Margin_Des] AS NVARCHAR(MAX)) AS wall_margin_des,
  CAST(s.[Solid_Component] AS NVARCHAR(MAX)) AS solid_component,
  CAST(s.[r_Position] AS NVARCHAR(MAX)) AS r_position,
  CAST(s.[r_Position_Des] AS NVARCHAR(MAX)) AS r_position_des,
  CAST(s.[l_Position] AS NVARCHAR(MAX)) AS l_position,
  CAST(s.[l_Position_Des] AS NVARCHAR(MAX)) AS l_position_des,
  CAST(s.[l_Position_Clock] AS NVARCHAR(MAX)) AS l_position_clock,
  CAST(s.[r_Position_Clock] AS NVARCHAR(MAX)) AS r_position_clock
`.trim();

export const MSSQL_ULTRASOUND_CYST_KEYSET_SELECT = `
SELECT
  ${ULTRASOUND_CYST_COLUMNS}
FROM (
  SELECT TOP (@page)
    ${ULTRASOUND_CYST_STAGING_COLUMNS}
  FROM {{sourceObject}}
  WHERE (
    [Exam_ID] > @afterExamId
    OR ([Exam_ID] = @afterExamId AND [Described_Cyst_ID] > @afterChildId)
  )
    AND (@migrateSrcKeyMin IS NULL OR CAST([Exam_ID] AS BIGINT) >= @migrateSrcKeyMin)
    AND (@migrateSrcKeyMax IS NULL OR CAST([Exam_ID] AS BIGINT) <= @migrateSrcKeyMax)
  ORDER BY [Exam_ID] ASC, [Described_Cyst_ID] ASC
) s
`.trim();

export const MSSQL_ULTRASOUND_CYST_BY_EXAM_IDS_SELECT = `
SELECT
  ${ULTRASOUND_CYST_COLUMNS}
FROM {{sourceObject}}
WHERE [Exam_ID] IN ({{idPlaceholders}})
ORDER BY [Exam_ID] ASC, [Described_Cyst_ID] ASC
`.trim();
