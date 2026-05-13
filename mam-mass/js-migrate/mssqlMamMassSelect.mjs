const MAM_MASS_STAGING_COLUMNS = `
  [Described_Mass_ID],
  [Exam_ID],
  [Exam_Date],
  [PID],
  [Shape],
  [Shape_Des],
  [Wall_Margin],
  [Wall_Margin_Des],
  [Cal_in_Mass],
  [Size_Width],
  [Size_Depth],
  [Mass_Density],
  [Mass_Density_Des],
  [l_Position],
  [l_Position_Des],
  [r_Position],
  [r_Position_Des],
  [Depth],
  [Depth_Des],
  [l_Position_Clock],
  [r_Position_Clock]
`.trim();

const MAM_MASS_COLUMNS = `
  CAST(s.[Described_Mass_ID] AS NVARCHAR(MAX)) AS described_mass_id,
  CAST(CAST(s.[Exam_ID] AS BIGINT) AS NVARCHAR(MAX)) AS exam_id,
  CONVERT(VARCHAR(30), s.[Exam_Date], 126) AS exam_date,
  CAST(s.[PID] AS NVARCHAR(MAX)) AS pid,
  CAST(s.[Shape] AS NVARCHAR(MAX)) AS shape,
  CAST(s.[Shape_Des] AS NVARCHAR(MAX)) AS shape_des,
  CAST(s.[Wall_Margin] AS NVARCHAR(MAX)) AS wall_margin,
  CAST(s.[Wall_Margin_Des] AS NVARCHAR(MAX)) AS wall_margin_des,
  CAST(s.[Cal_in_Mass] AS NVARCHAR(MAX)) AS cal_in_mass,
  CAST(s.[Size_Width] AS NVARCHAR(MAX)) AS size_width,
  CAST(s.[Size_Depth] AS NVARCHAR(MAX)) AS size_depth,
  CAST(s.[Mass_Density] AS NVARCHAR(MAX)) AS mass_density,
  CAST(s.[Mass_Density_Des] AS NVARCHAR(MAX)) AS mass_density_des,
  CAST(s.[l_Position] AS NVARCHAR(MAX)) AS l_position,
  CAST(s.[l_Position_Des] AS NVARCHAR(MAX)) AS l_position_des,
  CAST(s.[r_Position] AS NVARCHAR(MAX)) AS r_position,
  CAST(s.[r_Position_Des] AS NVARCHAR(MAX)) AS r_position_des,
  CAST(s.[Depth] AS NVARCHAR(MAX)) AS depth,
  CAST(s.[Depth_Des] AS NVARCHAR(MAX)) AS depth_des,
  CAST(s.[l_Position_Clock] AS NVARCHAR(MAX)) AS l_position_clock,
  CAST(s.[r_Position_Clock] AS NVARCHAR(MAX)) AS r_position_clock
`.trim();

export const MSSQL_MAM_MASS_KEYSET_SELECT = `
SELECT
  ${MAM_MASS_COLUMNS}
FROM (
  SELECT TOP (@page)
    ${MAM_MASS_STAGING_COLUMNS}
  FROM {{sourceObject}}
  WHERE [Exam_ID] > @afterExamId
     OR ([Exam_ID] = @afterExamId AND [Described_Mass_ID] > @afterChildId)
  ORDER BY [Exam_ID] ASC, [Described_Mass_ID] ASC
) s
`.trim();
