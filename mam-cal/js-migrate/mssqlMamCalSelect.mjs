const MAM_CAL_STAGING_COLUMNS = `
  [Described_Cal_ID],
  [Exam_ID],
  [Exam_Date],
  [PID],
  [Type],
  [Type_Des],
  [Distribution],
  [Distribution_Des],
  [r_Position],
  [r_Position_Des],
  [l_Position],
  [l_Position_Des],
  [l_Position_Clock],
  [r_Position_Clock]
`.trim();

const MAM_CAL_COLUMNS = `
  CAST(s.[Described_Cal_ID] AS NVARCHAR(MAX)) AS described_cal_id,
  CAST(CAST(s.[Exam_ID] AS BIGINT) AS NVARCHAR(MAX)) AS exam_id,
  CONVERT(VARCHAR(30), s.[Exam_Date], 126) AS exam_date,
  CAST(s.[PID] AS NVARCHAR(MAX)) AS pid,
  CAST(s.[Type] AS NVARCHAR(MAX)) AS type,
  CAST(s.[Type_Des] AS NVARCHAR(MAX)) AS type_des,
  CAST(s.[Distribution] AS NVARCHAR(MAX)) AS distribution,
  CAST(s.[Distribution_Des] AS NVARCHAR(MAX)) AS distribution_des,
  CAST(s.[r_Position] AS NVARCHAR(MAX)) AS r_position,
  CAST(s.[r_Position_Des] AS NVARCHAR(MAX)) AS r_position_des,
  CAST(s.[l_Position] AS NVARCHAR(MAX)) AS l_position,
  CAST(s.[l_Position_Des] AS NVARCHAR(MAX)) AS l_position_des,
  CAST(s.[l_Position_Clock] AS NVARCHAR(MAX)) AS l_position_clock,
  CAST(s.[r_Position_Clock] AS NVARCHAR(MAX)) AS r_position_clock
`.trim();

export const MSSQL_MAM_CAL_KEYSET_SELECT = `
SELECT
  ${MAM_CAL_COLUMNS}
FROM (
  SELECT TOP (@page)
    ${MAM_CAL_STAGING_COLUMNS}
  FROM {{sourceObject}}
  WHERE [Exam_ID] > @afterExamId
     OR ([Exam_ID] = @afterExamId AND [Described_Cal_ID] > @afterChildId)
  ORDER BY [Exam_ID] ASC, [Described_Cal_ID] ASC
) s
`.trim();

export const MSSQL_MAM_CAL_BY_EXAM_IDS_SELECT = `
SELECT
  ${MAM_CAL_COLUMNS}
FROM {{sourceObject}}
WHERE [Exam_ID] IN ({{idPlaceholders}})
ORDER BY [Exam_ID] ASC, [Described_Cal_ID] ASC
`.trim();
