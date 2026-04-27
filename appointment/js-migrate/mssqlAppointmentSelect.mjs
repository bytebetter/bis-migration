/**
 * คิวรีอ่าน dbo.schedule จาก MSSQL แบบแบ่งหน้า
 */
export const MSSQL_APPOINTMENT_SELECT = `
SELECT
  CONVERT(VARCHAR(30), [Schedule_Datetime], 126) AS schedule_datetime,
  CAST(CAST([Schedule_Number] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS schedule_number,
  CAST([Prefix] AS NVARCHAR(MAX)) AS prefix,
  CAST([Name] AS NVARCHAR(MAX)) AS [name],
  CAST([Surname] AS NVARCHAR(MAX)) AS surname,
  CAST(CAST([Payment_Type] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS payment_type,
  CAST(CAST([Patient_Type] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS patient_type,
  CAST([PID] AS NVARCHAR(MAX)) AS pid,
  CAST(CAST([Age] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS age,
  CONVERT(VARCHAR(30), [Receive_Date], 126) AS receive_date,
  CAST([LoginName] AS NVARCHAR(MAX)) AS login_name,
  CAST([MemoDetail] AS NVARCHAR(MAX)) AS memo_detail,
  CAST(CAST([Fail] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS fail,
  CAST([Telephone] AS NVARCHAR(MAX)) AS telephone,
  CAST([Inventional] AS NVARCHAR(MAX)) AS inventional,
  CONVERT(VARCHAR(30), [ModifiedDate], 126) AS modified_date,
  CAST([ModifiedUser] AS NVARCHAR(MAX)) AS modified_user,
  CAST([BiopsyProc] AS NVARCHAR(MAX)) AS biopsy_proc,
  CAST([ReferringMD] AS NVARCHAR(MAX)) AS referring_md,
  CAST([BiopsyComment] AS NVARCHAR(MAX)) AS biopsy_comment,
  CAST([BiopsyRadiologist] AS NVARCHAR(MAX)) AS biopsy_radiologist,
  CAST(CAST([Schedule_ID] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS schedule_id,
  CAST([Mobile] AS NVARCHAR(MAX)) AS mobile,
  CAST(CAST([Location_ID] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS location_id,
  CAST([IsOnline] AS NVARCHAR(MAX)) AS is_online,
  CAST([HaveDoc] AS NVARCHAR(MAX)) AS have_doc,
  CAST([HaveCD] AS NVARCHAR(MAX)) AS have_cd,
  CAST(CAST([Right_ID] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS right_id
FROM {{sourceObject}}
ORDER BY {{orderBy}}
OFFSET @offset ROWS FETCH NEXT @page ROWS ONLY;
`.trim();
