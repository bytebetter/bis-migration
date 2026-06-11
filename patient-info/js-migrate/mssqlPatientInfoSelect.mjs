/**
 * คิวรีอ่าน dbo.patient_info จาก MSSQL แบ่งหน้า
 *
 * เรียง PID: ตัวเลขก่อน (เรียงตามค่าตัวเลข) แล้วตามด้วย non-numeric (เรียงตามข้อความ)
 * ใช้ sort_key สำหรับ keyset pagination แทน OFFSET ในโหมด resume
 */

export const MSSQL_PID_TRIM_EXPR = `LTRIM(RTRIM(CAST([PID] AS NVARCHAR(4000))))`;

/** NULL เมื่อ PID ไม่ใช่จำนวนเต็ม */
export const MSSQL_PID_NUMERIC_BIGINT_EXPR = `TRY_CAST(${MSSQL_PID_TRIM_EXPR} AS BIGINT)`;

/**
 * คีย์เรียงคงที่: N'0' + zero-pad 20 หลักสำหรับตัวเลข, N'1' + ข้อความสำหรับ non-numeric
 * ตัวอย่าง: 1234 → 0...001234, T998 → 1T998
 */
export const MSSQL_PID_SORT_KEY_EXPR = `CASE WHEN ${MSSQL_PID_NUMERIC_BIGINT_EXPR} IS NOT NULL
  THEN CONCAT(
    N'0',
    RIGHT(
      REPLICATE(N'0', 20) + CAST(${MSSQL_PID_NUMERIC_BIGINT_EXPR} AS NVARCHAR(30)),
      20
    )
  )
  ELSE CONCAT(N'1', ${MSSQL_PID_TRIM_EXPR})
END`;

export const MSSQL_PID_ORDER_BY = `${MSSQL_PID_SORT_KEY_EXPR} ASC`;

/** ORDER BY เร็วสำหรับ bulk migrate ครั้งแรก (Postgres ว่าง) — ไม่คำนวณ sort_key ทุกแถวบน MSSQL */
export const MSSQL_PID_FAST_ORDER_BY = "[PID] ASC";

export const MSSQL_PATIENT_INFO_SRC_WHERE = `
(@migrateSrcKeyMin IS NULL OR ${MSSQL_PID_NUMERIC_BIGINT_EXPR} >= @migrateSrcKeyMin)
  AND (@migrateSrcKeyMax IS NULL OR ${MSSQL_PID_NUMERIC_BIGINT_EXPR} <= @migrateSrcKeyMax)`;

const MSSQL_PATIENT_INFO_DETAIL_COLUMNS = `
  CAST([PID] AS NVARCHAR(MAX)) AS pid,
  CAST([Prefix] AS NVARCHAR(MAX)) AS prefix,
  CAST([Name] AS NVARCHAR(MAX)) AS [name],
  CAST([Surname] AS NVARCHAR(MAX)) AS surname,
  CONVERT(VARCHAR(30), [DateOfBirth], 126) AS date_of_birth_be,
  CAST([Single] AS NVARCHAR(MAX)) AS single,
  CAST([Address] AS NVARCHAR(MAX)) AS address,
  CAST([SubArea] AS NVARCHAR(MAX)) AS sub_area,
  CAST([Area] AS NVARCHAR(MAX)) AS area,
  CAST([Province] AS NVARCHAR(MAX)) AS province,
  CAST([Zip] AS NVARCHAR(MAX)) AS zip,
  CAST([Phone_BIZ] AS NVARCHAR(MAX)) AS phone_biz,
  CAST([Phone_Home] AS NVARCHAR(MAX)) AS phone_home,
  CAST(CAST([Height] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS height,
  CAST(CAST([Weight] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS weight,
  CAST([Current_Breast_Compo] AS NVARCHAR(MAX)) AS current_breast_compo,
  CAST([Current_implant_Type] AS NVARCHAR(MAX)) AS current_implant_type,
  CONVERT(VARCHAR(30), [LastExamDate], 126) AS last_exam_date,
  CAST([Mobile] AS NVARCHAR(MAX)) AS mobile,
  CONVERT(VARCHAR(30), [MobileUpdated], 126) AS mobile_updated,
  CAST(CAST([Donate_Type] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS donate_type,
  CAST([EngPrefix] AS NVARCHAR(MAX)) AS eng_prefix,
  CAST([EngName] AS NVARCHAR(MAX)) AS eng_name,
  CAST([EngSurname] AS NVARCHAR(MAX)) AS eng_surname,
  CAST([SocID] AS NVARCHAR(MAX)) AS soc_id,
  CAST([HN] AS NVARCHAR(MAX)) AS hn,
  CAST([Gender] AS NVARCHAR(MAX)) AS gender,
  CAST([Address2] AS NVARCHAR(MAX)) AS address2,
  CAST([ShortNote] AS NVARCHAR(MAX)) AS short_note,
  CAST([Disease] AS NVARCHAR(MAX)) AS disease,
  CAST([Mobile_Phone] AS NVARCHAR(MAX)) AS mobile_phone,
  CAST([Email] AS NVARCHAR(MAX)) AS email`.trim();

/** OFFSET (legacy) — ยังใช้ ORDER BY sort_key เดียวกัน */
export const MSSQL_PATIENT_INFO_SELECT = `
SELECT
  ${MSSQL_PATIENT_INFO_DETAIL_COLUMNS}
FROM {{sourceObject}}
WHERE ${MSSQL_PATIENT_INFO_SRC_WHERE}
ORDER BY {{orderBy}}
OFFSET @offset ROWS FETCH NEXT @page ROWS ONLY;
`.trim();

/** keyset: อ่านชุดถัดไปหลัง sort_key ล่าสุด */
export function buildMssqlPatientInfoKeysetSelect() {
  return `
SELECT TOP (@page)
  ${MSSQL_PATIENT_INFO_DETAIL_COLUMNS},
  ${MSSQL_PID_SORT_KEY_EXPR} AS __mssql_pid_sort_key
FROM {{sourceObject}}
WHERE ${MSSQL_PID_SORT_KEY_EXPR} > @afterPidSortKey
  AND ${MSSQL_PATIENT_INFO_SRC_WHERE}
ORDER BY ${MSSQL_PID_ORDER_BY};
`.trim();
}

/** keyset เบา: ดึงเฉพาะ PID + sort_key ก่อน (insert-only ข้ามที่มีใน Postgres แล้ว) */
export function buildMssqlPatientInfoIdProbeKeysetSelect() {
  return `
SELECT TOP (@page)
  CAST([PID] AS NVARCHAR(MAX)) AS pid,
  ${MSSQL_PID_SORT_KEY_EXPR} AS __mssql_pid_sort_key
FROM {{sourceObject}}
WHERE ${MSSQL_PID_SORT_KEY_EXPR} > @afterPidSortKey
  AND ${MSSQL_PATIENT_INFO_SRC_WHERE}
ORDER BY ${MSSQL_PID_ORDER_BY};
`.trim();
}

/** สรุปต้นทางสำหรับ smart resume (COUNT + MAX sort_key) */
export function buildMssqlPatientInfoSourceFingerprintSql() {
  return `
SELECT
  COUNT_BIG(1) AS total_n,
  MAX(${MSSQL_PID_SORT_KEY_EXPR}) AS max_sort_key
FROM {{sourceObject}}
WHERE ${MSSQL_PATIENT_INFO_SRC_WHERE};
`.trim();
}

/** นับแถวในช่วง sort_key (after, max] — ตรวจว่าแถวใหม่ทั้งหมดอยู่ท้ายลำดับหรือไม่ */
export function buildMssqlPatientInfoSortKeyTailCountSql() {
  return `
SELECT COUNT_BIG(1) AS tail_n
FROM {{sourceObject}}
WHERE ${MSSQL_PID_SORT_KEY_EXPR} > @afterSortKeyExclusive
  AND ${MSSQL_PID_SORT_KEY_EXPR} <= @maxSortKeyInclusive
  AND ${MSSQL_PATIENT_INFO_SRC_WHERE};
`.trim();
}

/** repair-from-log / ดึงตามรายการ PID */
export const MSSQL_PATIENT_INFO_BY_PIDS_SELECT = `
SELECT
  ${MSSQL_PATIENT_INFO_DETAIL_COLUMNS}
FROM {{sourceObject}}
WHERE [PID] IN ({{idPlaceholders}})
ORDER BY ${MSSQL_PID_ORDER_BY}
`.trim();
