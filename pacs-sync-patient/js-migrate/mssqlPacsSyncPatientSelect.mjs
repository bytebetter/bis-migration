/**
 * คิวรี dbo.PACS_SYNC_PATIENT — log การ sync ชื่อ/PID คนไข้ขึ้น PACS
 *
 * ต้นทางไม่มี PK / identity / CreatedDate (20 คอลัมน์ จบที่ IsGenerated)
 * เรียง UpdateTime (yyyyMMddHHmmss เป็น string → เรียงตัวอักษร = เรียงเวลา) เก่า → ใหม่
 * เพื่อให้ log ใหม่อยู่ท้ายเสมอ → resume forward เก็บแถวใหม่ได้ (แบบเดียวกับ SCHEDULE_LOG)
 *
 * alias ของ SELECT = ชื่อคอลัมน์ปลายทาง (public.pacs_sync_patient) ตรงตัว
 * มี 2 คู่ที่ชื่อไม่เหมือนต้นทาง — ลำดับคอลัมน์ MSSQL กับ Directus ตรงกันเป๊ะ ใช้ยืนยันคู่นี้ได้:
 *   [OldPID] -> old_old_pid   (PID ชุดก่อนหน้าใน log)
 *   [PID]    -> old_pid       (prefix old_ = "มาจากฐานเดิม" เหมือน pacs_sync_info.old_pid <- pid)
 * ส่วน patient (FK) / file_name ไม่มีต้นทาง — patient resolve จาก old_pid ตอน INSERT, file_name เป็น NULL
 */

/** ความยาวที่ตัดใน ORDER BY/keyset — ฝั่ง JS ต้องตัดเท่ากันก่อน bind ไม่งั้นเทียบคนละค่า */
export const MSSQL_PSP_KEYSET_TEXT_LEN = 64;

/**
 * ORDER BY / keyset: UpdateTime ที่เห็นเป็น varchar 'yyyyMMddHHmm(ss)' — เรียงตัวอักษร = เรียงเวลา
 * ใช้ CONVERT style 126 ไว้กันเหนียว: ถ้าฐานจริงประกาศคอลัมน์นี้เป็น datetime จะได้ ISO8601
 * (เรียงตัวอักษรถูกเหมือนกัน) แทนรูปแบบ default ที่ขึ้นต้นด้วยชื่อเดือน — style ถูกเมินเมื่อต้นทางเป็น char อยู่แล้ว
 */
export const MSSQL_PSP_UPDATE_TIME_ORDER_EXPR = `COALESCE(CONVERT(NVARCHAR(${MSSQL_PSP_KEYSET_TEXT_LEN}), [UpdateTime], 126), N'')`;

export const MSSQL_PSP_PID_ORDER_EXPR = `COALESCE(CAST([PID] AS NVARCHAR(${MSSQL_PSP_KEYSET_TEXT_LEN})), N'')`;

/**
 * tie-breaker สุดท้าย — %%physloc%% = ตำแหน่ง physical ของแถว (binary(8), file:page:slot)
 * PACS_SYNC_PATIENT ไม่มี PK/unique ใดๆ และแถว log ที่ (UpdateTime, PID) ซ้ำกันมีจริง
 * (คนไข้คนเดียว sync หลายไฟล์ในวินาทีเดียว) — ถ้าไม่มีคีย์ unique ปิดท้าย keyset จะข้ามแถวที่ขอบ page
 * ใช้ได้ภายใต้ SNAPSHOT isolation ที่ physloc คงที่ตลอด run
 */
export const MSSQL_PSP_PHYSLOC_ORDER_EXPR = "%%physloc%%";

export const MSSQL_PACS_SYNC_PATIENT_ORDER_BY = `${MSSQL_PSP_UPDATE_TIME_ORDER_EXPR} ASC, ${MSSQL_PSP_PID_ORDER_EXPR} ASC, ${MSSQL_PSP_PHYSLOC_ORDER_EXPR} ASC`;

const SELECT_COLUMNS = `
  CONVERT(NVARCHAR(255), [UpdateTime], 126) AS update_time,
  CONVERT(NVARCHAR(255), [OldName]) AS old_name,
  CONVERT(NVARCHAR(255), [OldMiddleName]) AS old_middle_name,
  CONVERT(NVARCHAR(255), [OldSurname]) AS old_surname,
  CONVERT(NVARCHAR(255), [OldEngName]) AS old_engname,
  CONVERT(NVARCHAR(255), [OldEngMiddleName]) AS old_eng_middle_name,
  CONVERT(NVARCHAR(255), [OldEngSurname]) AS old_eng_surname,
  CONVERT(NVARCHAR(255), [OldPID]) AS old_old_pid,
  CONVERT(NVARCHAR(255), [OldDateOfBirth]) AS old_date_of_birth,
  CONVERT(NVARCHAR(255), [OldGender]) AS old_gender,
  CONVERT(NVARCHAR(255), [Name]) AS name,
  CONVERT(NVARCHAR(255), [MiddleName]) AS middle_name,
  CONVERT(NVARCHAR(255), [Surname]) AS surname,
  CONVERT(NVARCHAR(255), [EngName]) AS engname,
  CONVERT(NVARCHAR(255), [EngMiddleName]) AS eng_middle_name,
  CONVERT(NVARCHAR(255), [EngSurname]) AS eng_surname,
  CONVERT(NVARCHAR(255), [PID]) AS old_pid,
  CONVERT(NVARCHAR(255), [DateOfBirth]) AS date_of_birth,
  CONVERT(NVARCHAR(255), [Gender]) AS gender,
  CONVERT(NVARCHAR(255), [IsGenerated]) AS is_generated
`.trim();

/** ค่าเลื่อน cursor ต้องมาจาก expression เดียวกับ ORDER BY — ไม่อ่านจาก alias ข้างบนอย่างเดียว */
const KEYSET_CURSOR_ANCHOR_COLUMNS = `
  , ${MSSQL_PSP_UPDATE_TIME_ORDER_EXPR} AS ktv_update_time_ord
  , ${MSSQL_PSP_PID_ORDER_EXPR} AS ktv_pid_ord
  , ${MSSQL_PSP_PHYSLOC_ORDER_EXPR} AS ktv_physloc
`.trim();

/** fallback เมื่อ resume checkpoint เก่า (OFFSET) หรือถูกบังคับด้วย --source-index-range */
export const MSSQL_PACS_SYNC_PATIENT_SELECT = `
SELECT
  ${SELECT_COLUMNS}
FROM {{sourceObject}}
ORDER BY {{orderBy}}
OFFSET @offset ROWS FETCH NEXT @page ROWS ONLY;
`.trim();

/** แถวที่อยู่หลังที่คั่นหน้า (@afterUpdateTime, @afterPid, @afterPhysloc) — ใช้ร่วมกับตัวปรับ offset */
export const MSSQL_PACS_SYNC_PATIENT_KEYSET_AFTER_PREDICATE = `(
    ${MSSQL_PSP_UPDATE_TIME_ORDER_EXPR} > @afterUpdateTime
    OR (
      ${MSSQL_PSP_UPDATE_TIME_ORDER_EXPR} = @afterUpdateTime
      AND ${MSSQL_PSP_PID_ORDER_EXPR} > @afterPid
    )
    OR (
      ${MSSQL_PSP_UPDATE_TIME_ORDER_EXPR} = @afterUpdateTime
      AND ${MSSQL_PSP_PID_ORDER_EXPR} = @afterPid
      AND ${MSSQL_PSP_PHYSLOC_ORDER_EXPR} > @afterPhysloc
    )
  )`;

/**
 * Keyset ตาม (UpdateTime, PID, %%physloc%%) ASC — cursor เลื่อนด้วย > (เก่า→ใหม่ แถวใหม่อยู่ท้าย)
 */
export function buildMssqlPacsSyncPatientKeysetSelect(
  orderBy = MSSQL_PACS_SYNC_PATIENT_ORDER_BY,
) {
  return `
SELECT TOP (@page)
  ${SELECT_COLUMNS}
  ${KEYSET_CURSOR_ANCHOR_COLUMNS}
FROM {{sourceObject}}
WHERE ${MSSQL_PACS_SYNC_PATIENT_KEYSET_AFTER_PREDICATE}
ORDER BY ${orderBy};
`.trim();
}

/**
 * predicate ของ repair-from-log — ต้องใช้ expression ชุดเดียวกับ ORDER BY
 * (คีย์ที่ยาวเกิน 64 ตัวถูกตัดทั้งสองฝั่ง อาจดึงแถวที่ prefix ซ้ำติดมาด้วย — ยอมรับได้สำหรับ repair)
 * @param {number} i ลำดับพารามิเตอร์ @ut<i> / @pid<i>
 */
export function buildPacsSyncPatientLogKeyPredicate(i) {
  return `(${MSSQL_PSP_UPDATE_TIME_ORDER_EXPR} = @ut${i} AND ${MSSQL_PSP_PID_ORDER_EXPR} = @pid${i})`;
}

/** repair-from-log: ดึงตาม log_key (UpdateTime + PID) */
export const MSSQL_PACS_SYNC_PATIENT_BY_LOG_KEYS_SELECT = `
SELECT
  ${SELECT_COLUMNS}
FROM {{sourceObject}}
WHERE (
    {{logKeyPredicates}}
  )
ORDER BY ${MSSQL_PACS_SYNC_PATIENT_ORDER_BY};
`.trim();
