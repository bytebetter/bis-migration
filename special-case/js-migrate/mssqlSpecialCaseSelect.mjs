/**
 * dbo.SPECIAL_CASE — เคสพิเศษ / teaching case ของคนไข้ (หลักพันแถว)
 *
 * PK_SPECIAL_CASE = (PID, Sequence) clustered unique — Sequence เป็นลำดับต่อคนไข้ (0, 1, …) ไม่ใช่ id ทั้งตาราง
 * คีย์ข้อความที่ใช้ใน log / --source-ids / repair-from-log = "PID|Sequence" เช่น 100025|0
 *
 * alias ของ SELECT = ชื่อคอลัมน์ปลายทาง (public.special_case) ตรงตัว:
 *   [PID] -> old_pid, [Sequence] -> sequence, [SpecialCase_Point] -> special_case_point,
 *   [SpecialCase_Point_Des] -> special_case_point_des, [SpecialCase_Detail] -> special_case_detail
 * relation patient_info ไม่มีต้นทาง — resolve จาก old_pid ฝั่ง Postgres
 *
 * ชนิดต้นทาง: PID sPID_Type (10), SpecialCase_Point tinyint, _Des varchar(64), _Detail varchar(1024), Sequence int
 */

/** PID ตัดช่องว่างหัวท้าย */
const PID_EXPR = "LTRIM(RTRIM(CONVERT(NVARCHAR(255), [PID])))";

/** Sequence เป็น int NOT NULL — ข้อความเลขล้วน */
const SEQUENCE_EXPR = "CONVERT(NVARCHAR(20), [Sequence])";

/** คีย์ข้อความ "PID|Sequence" — ต้องตรงกับ specialCaseRowKey() ฝั่ง JS */
const KEY_EXPR = `(${PID_EXPR} + N'|' + ${SEQUENCE_EXPR})`;

/** ลำดับอ่านแบบ OFFSET ตาม PK (ไม่ซ้ำ) — ลำดับนิ่งโดยไม่ต้องปิดท้ายด้วย %%physloc%% */
export const MSSQL_SPECIAL_CASE_ORDER_BY = "[PID] ASC, [Sequence] ASC";

const SELECT_COLUMNS = `
  ${PID_EXPR} AS old_pid,
  ${SEQUENCE_EXPR} AS [sequence],
  CONVERT(NVARCHAR(10), [SpecialCase_Point]) AS special_case_point,
  CAST([SpecialCase_Point_Des] AS NVARCHAR(MAX)) AS special_case_point_des,
  CAST([SpecialCase_Detail] AS NVARCHAR(MAX)) AS special_case_detail
`.trim();

/** หน้าถัดไปตามลำดับ — @offset/@page มาจาก sourceIndexRange ของ job (เดินครบทุกแถวทุกรอบ) */
export const MSSQL_SPECIAL_CASE_SELECT = `
SELECT
  ${SELECT_COLUMNS}
FROM {{sourceObject}}
ORDER BY ${MSSQL_SPECIAL_CASE_ORDER_BY}
OFFSET @offset ROWS FETCH NEXT @page ROWS ONLY;
`.trim();

/** repair-from-log / --source-ids: ดึงตามคีย์ "PID|Sequence" (เทียบตาม collation ต้นทาง) */
export const MSSQL_SPECIAL_CASE_BY_KEYS_SELECT = `
SELECT
  ${SELECT_COLUMNS}
FROM {{sourceObject}}
WHERE ${KEY_EXPR} IN ({{idPlaceholders}})
ORDER BY ${MSSQL_SPECIAL_CASE_ORDER_BY};
`.trim();
