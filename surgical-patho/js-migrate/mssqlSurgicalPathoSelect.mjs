/**
 * dbo.SURGICAL_PATHO — ผลพยาธิวิทยาหลังผ่าตัด (หลักหมื่นแถว)
 *
 * คีย์ประจำแถว = (PID, Surgical_ID) — Surgical_ID เป็นเลขลำดับที่นับใหม่ต่อคนไข้ (1, 2, …) ไม่ใช่ id ทั้งตาราง
 * คีย์ข้อความที่ใช้ใน log / --source-ids / repair-from-log = "PID|Surgical_ID" เช่น 100067|2
 *
 * alias ของ SELECT = ชื่อคอลัมน์ปลายทาง (public.surgical_patho) ตรงตัว:
 *   [PID] -> old_pid, [Surgical_ID] -> old_surgical_id, [Exam_ID] -> old_exam_id,
 *   [BiopsyID] -> old_biopsy_id, [last_exam_id] -> old_last_exam_id, ที่เหลือชื่อเดียวกันแบบ snake_case
 * relation (patient_info / exam / procedure / last_exam) ไม่มีต้นทาง — resolve จาก old_* ฝั่ง Postgres
 *
 * Surgical_Date ส่งเป็นข้อความ ISO (CONVERT style 126) ไม่ให้ driver แปลงเป็น JS Date (TZ เครื่องเพี้ยนได้)
 */

/** PID ตัดช่องว่างหัวท้าย */
const PID_EXPR = "LTRIM(RTRIM(CONVERT(NVARCHAR(255), [PID])))";

/**
 * เลข id ต้นทางเป็นข้อความเลขล้วน ไม่ว่าคอลัมน์จะเป็น int / numeric / float / varchar
 * — ต้องได้รูปเดียวกับ examination.old_exam_id และ procedure.old_db_id ("<Exam_ID>_<BiopsyID>")
 * ค่าว่างเป็น NULL ก่อน (CONVERT(BIGINT, '') ได้ 0 ไม่ใช่ NULL); แปลงเป็นเลขไม่ได้ = เก็บข้อความเดิม
 * @param {string} col
 */
function idTextExpr(col) {
  const raw = `LTRIM(RTRIM(CONVERT(NVARCHAR(100), ${col})))`;
  return `CASE WHEN ${col} IS NULL OR ${raw} = N'' THEN NULL
    ELSE COALESCE(CONVERT(NVARCHAR(50), TRY_CONVERT(BIGINT, ${col})), ${raw}) END`;
}

const SURGICAL_ID_EXPR = idTextExpr("[Surgical_ID]");

/** คีย์ข้อความ "PID|Surgical_ID" — ต้องตรงกับ surgicalPathoRowKey() ฝั่ง JS */
const KEY_EXPR = `(${PID_EXPR} + N'|' + ${SURGICAL_ID_EXPR})`;

/**
 * ลำดับอ่านแบบ OFFSET — %%physloc%% ปิดท้ายกันลำดับไม่นิ่ง ถ้าต้นทางมี (PID, Surgical_ID) ซ้ำ
 * (ยังไม่ได้ยืนยันว่าต้นทางมี PK) แถวซ้ำที่ขอบหน้าจะได้ไม่ถูกข้าม/อ่านซ้ำ
 */
export const MSSQL_SURGICAL_PATHO_ORDER_BY =
  "[PID] ASC, TRY_CONVERT(BIGINT, [Surgical_ID]) ASC, %%physloc%% ASC";

const SELECT_COLUMNS = `
  ${PID_EXPR} AS old_pid,
  ${SURGICAL_ID_EXPR} AS old_surgical_id,
  CONVERT(NVARCHAR(30), [Surgical_Date], 126) AS surgical_date,
  CAST([Surgical_PathoCode] AS NVARCHAR(MAX)) AS surgical_patho_code,
  CAST([Surgical_PathoCode_FullDesc] AS NVARCHAR(MAX)) AS surgical_patho_code_full_desc,
  ${idTextExpr("[Exam_ID]")} AS old_exam_id,
  ${idTextExpr("[BiopsyID]")} AS old_biopsy_id,
  CAST([Location] AS NVARCHAR(MAX)) AS location,
  CAST([Radiologist] AS NVARCHAR(MAX)) AS radiologist,
  CAST([Discordance] AS NVARCHAR(MAX)) AS discordance,
  ${idTextExpr("[last_exam_id]")} AS old_last_exam_id
`.trim();

/** หน้าถัดไปตามลำดับ — @offset/@page มาจาก sourceIndexRange ของ job (เดินครบทุกแถวทุกรอบ) */
export const MSSQL_SURGICAL_PATHO_SELECT = `
SELECT
  ${SELECT_COLUMNS}
FROM {{sourceObject}}
ORDER BY ${MSSQL_SURGICAL_PATHO_ORDER_BY}
OFFSET @offset ROWS FETCH NEXT @page ROWS ONLY;
`.trim();

/** repair-from-log / --source-ids: ดึงตามคีย์ "PID|Surgical_ID" (เทียบตาม collation ต้นทาง) */
export const MSSQL_SURGICAL_PATHO_BY_KEYS_SELECT = `
SELECT
  ${SELECT_COLUMNS}
FROM {{sourceObject}}
WHERE ${KEY_EXPR} IN ({{idPlaceholders}})
ORDER BY ${MSSQL_SURGICAL_PATHO_ORDER_BY};
`.trim();
