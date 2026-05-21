/**
 * Predicate ช่วง [Schedule_Datetime] — ผูก @appointmentDtFrom / @appointmentDtToExcl เป็น NULL ได้
 * เมื่อทั้งคู่เป็น NULL จะไม่กรองวันที่
 */
export const MSSQL_APPOINTMENT_SCHEDULE_DATETIME_FILTER = `
(@appointmentDtFrom IS NULL OR [Schedule_Datetime] >= @appointmentDtFrom)
  AND (@appointmentDtToExcl IS NULL OR [Schedule_Datetime] < @appointmentDtToExcl)`;

/**
 * คิวรีอ่าน dbo.schedule จาก MSSQL แบบแบ่งหน้า
 *
 * ใช้ NVARCHAR(n) แทน NVARCHAR(MAX) ในฟิลด์ที่ความยาวจำกัดได้ — ลด LOB / payload ระหว่าง fetch
 * (ไม่แตะ schema ต้นทาง; แค่ปรับชนิดผลลัพธ์ใน SELECT)
 * เก็บ MAX เฉพาะ MemoDetail / BiopsyComment ที่อาจยาวมาก
 */
export const MSSQL_APPOINTMENT_SELECT = `
SELECT
  CONVERT(VARCHAR(30), [Schedule_Datetime], 126) AS schedule_datetime,
  CONVERT(NVARCHAR(50), [Schedule_Number]) AS schedule_number,
  CONVERT(NVARCHAR(4000), [Prefix]) AS prefix,
  CONVERT(NVARCHAR(4000), [Name]) AS [name],
  CONVERT(NVARCHAR(4000), [Surname]) AS surname,
  CONVERT(NVARCHAR(50), [Payment_Type]) AS payment_type,
  CONVERT(NVARCHAR(50), [Patient_Type]) AS patient_type,
  CONVERT(NVARCHAR(100), [PID]) AS pid,
  CONVERT(NVARCHAR(50), [Age]) AS age,
  CONVERT(VARCHAR(30), [Receive_Date], 126) AS receive_date,
  CONVERT(NVARCHAR(512), [LoginName]) AS login_name,
  CAST([MemoDetail] AS NVARCHAR(MAX)) AS memo_detail,
  CONVERT(NVARCHAR(50), [Fail]) AS fail,
  CONVERT(NVARCHAR(120), [Telephone]) AS telephone,
  CONVERT(NVARCHAR(200), [Inventional]) AS inventional,
  CONVERT(VARCHAR(30), [ModifiedDate], 126) AS modified_date,
  CONVERT(NVARCHAR(512), [ModifiedUser]) AS modified_user,
  CONVERT(NVARCHAR(2000), [BiopsyProc]) AS biopsy_proc,
  CONVERT(NVARCHAR(500), [ReferringMD]) AS referring_md,
  CAST([BiopsyComment] AS NVARCHAR(MAX)) AS biopsy_comment,
  CONVERT(NVARCHAR(500), [BiopsyRadiologist]) AS biopsy_radiologist,
  CONVERT(NVARCHAR(50), [Schedule_ID]) AS schedule_id,
  CONVERT(NVARCHAR(120), [Mobile]) AS mobile,
  CONVERT(NVARCHAR(50), [Location_ID]) AS location_id,
  CONVERT(NVARCHAR(50), [IsOnline]) AS is_online,
  CONVERT(NVARCHAR(50), [HaveDoc]) AS have_doc,
  CONVERT(NVARCHAR(50), [HaveCD]) AS have_cd,
  CONVERT(NVARCHAR(50), [Right_ID]) AS right_id
FROM {{sourceObject}}
WHERE {{appointmentScheduleDatetimeFilter}}
ORDER BY {{orderBy}}
OFFSET @offset ROWS FETCH NEXT @page ROWS ONLY;
`.trim();

const APPOINTMENT_SELECT_COLUMNS = `
  CONVERT(VARCHAR(30), [Schedule_Datetime], 126) AS schedule_datetime,
  CONVERT(NVARCHAR(50), [Schedule_Number]) AS schedule_number,
  CONVERT(NVARCHAR(4000), [Prefix]) AS prefix,
  CONVERT(NVARCHAR(4000), [Name]) AS [name],
  CONVERT(NVARCHAR(4000), [Surname]) AS surname,
  CONVERT(NVARCHAR(50), [Payment_Type]) AS payment_type,
  CONVERT(NVARCHAR(50), [Patient_Type]) AS patient_type,
  CONVERT(NVARCHAR(100), [PID]) AS pid,
  CONVERT(NVARCHAR(50), [Age]) AS age,
  CONVERT(VARCHAR(30), [Receive_Date], 126) AS receive_date,
  CONVERT(NVARCHAR(512), [LoginName]) AS login_name,
  CAST([MemoDetail] AS NVARCHAR(MAX)) AS memo_detail,
  CONVERT(NVARCHAR(50), [Fail]) AS fail,
  CONVERT(NVARCHAR(120), [Telephone]) AS telephone,
  CONVERT(NVARCHAR(200), [Inventional]) AS inventional,
  CONVERT(VARCHAR(30), [ModifiedDate], 126) AS modified_date,
  CONVERT(NVARCHAR(512), [ModifiedUser]) AS modified_user,
  CONVERT(NVARCHAR(2000), [BiopsyProc]) AS biopsy_proc,
  CONVERT(NVARCHAR(500), [ReferringMD]) AS referring_md,
  CAST([BiopsyComment] AS NVARCHAR(MAX)) AS biopsy_comment,
  CONVERT(NVARCHAR(500), [BiopsyRadiologist]) AS biopsy_radiologist,
  CONVERT(NVARCHAR(50), [Schedule_ID]) AS schedule_id,
  CONVERT(NVARCHAR(120), [Mobile]) AS mobile,
  CONVERT(NVARCHAR(50), [Location_ID]) AS location_id,
  CONVERT(NVARCHAR(50), [IsOnline]) AS is_online,
  CONVERT(NVARCHAR(50), [HaveDoc]) AS have_doc,
  CONVERT(NVARCHAR(50), [HaveCD]) AS have_cd,
  CONVERT(NVARCHAR(50), [Right_ID]) AS right_id
`.trim();

export const MSSQL_APPOINTMENT_ID_SELECT = `
SELECT TOP (@page)
  CAST([Schedule_ID] AS BIGINT) AS schedule_id
FROM {{sourceObject}}
WHERE [Schedule_ID] > @afterScheduleId
ORDER BY [Schedule_ID] ASC
`.trim();

export const MSSQL_APPOINTMENT_DETAIL_BY_IDS_SELECT = `
SELECT
  ${APPOINTMENT_SELECT_COLUMNS}
FROM {{sourceObject}}
WHERE [Schedule_ID] IN ({{idPlaceholders}})
ORDER BY [Schedule_ID] ASC
`.trim();
