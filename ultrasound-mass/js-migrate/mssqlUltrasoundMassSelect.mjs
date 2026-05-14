const ULTRASOUND_MASS_STAGING_COLUMNS = `
  [Described_Mass_ID],
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
  [Cal_in_Mass],
  [l_Position],
  [l_Position_Des],
  [r_Position],
  [r_Position_Des],
  [l_Position_Clock],
  [r_Position_Clock],
  [Orientation],
  [Orientation_Des],
  [Posterior_Features],
  [Posterior_Features_Des],
  [Vascularity],
  [Vascularity_Des],
  [Elasticity],
  [Elasticity_Des]
`.trim();

const ULTRASOUND_MASS_COLUMNS = `
  CAST(s.[Described_Mass_ID] AS NVARCHAR(MAX)) AS described_mass_id,
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
  CAST(s.[Cal_in_Mass] AS NVARCHAR(MAX)) AS cal_in_mass,
  CAST(s.[l_Position] AS NVARCHAR(MAX)) AS l_position,
  CAST(s.[l_Position_Des] AS NVARCHAR(MAX)) AS l_position_des,
  CAST(s.[r_Position] AS NVARCHAR(MAX)) AS r_position,
  CAST(s.[r_Position_Des] AS NVARCHAR(MAX)) AS r_position_des,
  CAST(s.[l_Position_Clock] AS NVARCHAR(MAX)) AS l_position_clock,
  CAST(s.[r_Position_Clock] AS NVARCHAR(MAX)) AS r_position_clock,
  CAST(s.[Orientation] AS NVARCHAR(MAX)) AS orientation,
  CAST(s.[Orientation_Des] AS NVARCHAR(MAX)) AS orientation_des,
  CAST(s.[Posterior_Features] AS NVARCHAR(MAX)) AS posterior_features,
  CAST(s.[Posterior_Features_Des] AS NVARCHAR(MAX)) AS posterior_features_des,
  CAST(s.[Vascularity] AS NVARCHAR(MAX)) AS vascularity,
  CAST(s.[Vascularity_Des] AS NVARCHAR(MAX)) AS vascularity_des,
  CAST(s.[Elasticity] AS NVARCHAR(MAX)) AS elasticity,
  CAST(s.[Elasticity_Des] AS NVARCHAR(MAX)) AS elasticity_des
`.trim();

export const MSSQL_ULTRASOUND_MASS_KEYSET_SELECT = `
SELECT
  ${ULTRASOUND_MASS_COLUMNS}
FROM (
  SELECT TOP (@page)
    ${ULTRASOUND_MASS_STAGING_COLUMNS}
  FROM {{sourceObject}}
  WHERE [Exam_ID] > @afterExamId
     OR ([Exam_ID] = @afterExamId AND [Described_Mass_ID] > @afterChildId)
  ORDER BY [Exam_ID] ASC, [Described_Mass_ID] ASC
) s
`.trim();
