/**
 * คิวรี dbo.SCHEDULE_LOG — เฉพาะ Activity = ย้ายวันนัด
 * เรียง LogTime เก่า → ใหม่ (ASC) เพื่อให้ log ใหม่อยู่ท้ายเสมอ → resume forward เก็บแถวใหม่ได้
 */
import { buildCreatedDateSortExprs } from "../../shared/js-migrate/mssqlCreatedDateSort.mjs";

export const MSSQL_APPOINTMENT_RESCHEDULE_ACTIVITY = "ย้ายวันนัด";

/** VARCHAR ยาวพอให้ค่า DATETIME2(7) style 126 ไม่ถูกตัด — ที่สั้นจะทำให้ keyset พลาดความคม */
const SELECT_COLUMNS = `
  CONVERT(VARCHAR(36), [Schedule_Datetime], 126) AS schedule_datetime,
  CONVERT(VARCHAR(36), [Old_Schedule_Datetime], 126) AS old_schedule_datetime,
  CONVERT(NVARCHAR(50), [Schedule_ID]) AS schedule_id,
  CONVERT(VARCHAR(36), [LogTime], 126) AS log_time,
  CONVERT(VARCHAR(36), [ModifiedDate], 126) AS modified_date
`.trim();

/** ใช้ใน ORDER BY / keyset — ให้ตรงกับ COALESCE เดียวกันทั้ง SELECT anchor / predicate */
export const MSSQL_RESCHEDULE_LOGTIME_ORDER_EXPR =
  "COALESCE(CAST([LogTime] AS DATETIME2(7)), CAST('17530101' AS DATETIME2))";

/** ใช้ใน ORDER BY / keyset ให้ NULL เรียงสม่ำเสมอ */
export const MSSQL_RESCHEDULE_SCHEDULE_ID_ORDER_EXPR =
  "COALESCE(TRY_CAST([Schedule_ID] AS BIGINT), CAST(-9223372036854775808 AS BIGINT))";

export const MSSQL_RESCHEDULE_SCHEDULE_DT_ORDER_EXPR =
  "COALESCE([Schedule_Datetime], CAST('17530101' AS DATETIME2))";

export const MSSQL_RESCHEDULE_MODIFIED_ORDER_EXPR =
  "COALESCE([ModifiedDate], CAST('17530101' AS DATETIME2))";

/** tie-breaker ระดับ 5 — แยกแถวที่สี่คีย์แรกซ้ำ (เคยข้ามแถวเมื่อ Old ต่างแต่ไม่อยู่ใน keyset) */
export const MSSQL_RESCHEDULE_OLD_SCHEDULE_DT_ORDER_EXPR =
  "COALESCE([Old_Schedule_Datetime], CAST('17530101' AS DATETIME2))";

/**
 * tie-breaker ระดับ 6 (สุดท้าย) — %%physloc%% = ตำแหน่ง physical ของแถว (binary(8), file:page:slot)
 * SCHEDULE_LOG ไม่มี PK/identity/unique ใดๆ; แถว log ที่ค่าทั้ง 5 คีย์บนซ้ำเป๊ะ (รวม 12 แถวที่เหมือนกันทุกคอลัมน์)
 * จะถูก keyset ข้ามที่ขอบ page ถ้าไม่มีคีย์ unique ปิดท้าย. physloc ทำให้คีย์ unique 100%
 * (verify: distinct(5-tuple + physloc) == COUNT). ใช้ได้ภายใต้ SNAPSHOT isolation ที่ physloc คงที่ตลอด run.
 */
export const MSSQL_RESCHEDULE_PHYSLOC_ORDER_EXPR = "%%physloc%%";

const RESCHEDULE_ORDER_BY = `${MSSQL_RESCHEDULE_LOGTIME_ORDER_EXPR} ASC, ${MSSQL_RESCHEDULE_SCHEDULE_ID_ORDER_EXPR} ASC, ${MSSQL_RESCHEDULE_SCHEDULE_DT_ORDER_EXPR} ASC, ${MSSQL_RESCHEDULE_MODIFIED_ORDER_EXPR} ASC, ${MSSQL_RESCHEDULE_OLD_SCHEDULE_DT_ORDER_EXPR} ASC, ${MSSQL_RESCHEDULE_PHYSLOC_ORDER_EXPR} ASC`;

const RESCHEDULE_TIEBREAKER_SORT_KEY = `CONCAT(
  CONVERT(VARCHAR(23), ${MSSQL_RESCHEDULE_LOGTIME_ORDER_EXPR}, 126),
  N'_',
  RIGHT(
    REPLICATE(N'0', 20) + CAST(${MSSQL_RESCHEDULE_SCHEDULE_ID_ORDER_EXPR} AS NVARCHAR(30)),
    20
  )
)`;

/** @param {string | null | undefined} createdDateColumn */
export function createMssqlAppointmentReschedulesSortBundle(createdDateColumn) {
  return buildCreatedDateSortExprs({
    createdDateColumn,
    tiebreakerOrderBy: RESCHEDULE_ORDER_BY,
    tiebreakerSortKeyExpr: RESCHEDULE_TIEBREAKER_SORT_KEY,
  });
}

export const defaultMssqlAppointmentReschedulesSortBundle =
  createMssqlAppointmentReschedulesSortBundle(null);

export const RESCHEDULE_ACTIVITY_WHERE = `[Activity] = N'${MSSQL_APPOINTMENT_RESCHEDULE_ACTIVITY}'`;

/** ORDER BY เดียวกับ keyset — ให้ OFFSET resume ตรงกับลำดับ keyset */
export const MSSQL_APPOINTMENT_RESCHEDULES_OFFSET_ORDER_BY = RESCHEDULE_ORDER_BY;

/**
 * รูปแบบที่คั่นหน้าของวันที่: ข้อความ style 121 ความละเอียดเต็ม DATETIME2(7)
 * (เดิมผ่าน JS Date เหลือแค่ ms → แถวสุดท้ายที่ LogTime มีเศษต่ำกว่า ms ถูกอ่านซ้ำ = insert ซ้ำ)
 */
export const RESCHEDULE_KEYSET_ANCHOR_FORMAT = "sql121";

/** @param {string} expr */
function anchorText(expr) {
  return `CONVERT(VARCHAR(27), ${expr}, 121)`;
}

/**
 * ค่าเลื่อน cursor ต้องมาจาก expression เดียวกับด้านบน — อย่าอ่านจาก CONVERT VARCHAR ใน OUTPUT อย่างเดียว
 */
const KEYSET_CURSOR_ANCHOR_COLUMNS = `
  , ${anchorText(MSSQL_RESCHEDULE_LOGTIME_ORDER_EXPR)} AS ktv_log_time_ord
  , ${MSSQL_RESCHEDULE_SCHEDULE_ID_ORDER_EXPR} AS ktv_schedule_id_ord
  , ${anchorText(MSSQL_RESCHEDULE_SCHEDULE_DT_ORDER_EXPR)} AS ktv_schedule_dt_ord
  , ${anchorText(MSSQL_RESCHEDULE_MODIFIED_ORDER_EXPR)} AS ktv_modified_ord
  , ${anchorText(MSSQL_RESCHEDULE_OLD_SCHEDULE_DT_ORDER_EXPR)} AS ktv_old_schedule_dt_ord
  , ${MSSQL_RESCHEDULE_PHYSLOC_ORDER_EXPR} AS ktv_physloc
`.trim();

/** param วันที่ส่งเป็นข้อความ style 121 — ให้ SQL แปลงเป็น DATETIME2(7) เอง */
const AFTER_LOG_TIME = "CAST(@afterLogTime AS DATETIME2(7))";
const AFTER_SCHEDULE_DT = "CAST(@afterScheduleDatetime AS DATETIME2(7))";
const AFTER_MODIFIED = "CAST(@afterModifiedDate AS DATETIME2(7))";
const AFTER_OLD_SCHEDULE_DT = "CAST(@afterOldScheduleDatetime AS DATETIME2(7))";

/**
 * แถวที่อยู่หลังที่คั่นหน้า — ใช้ร่วมกันระหว่าง query keyset และตัวปรับ offset
 * บรรทัดแรกเป็นเงื่อนไขถูกๆ: ที่คั่นหน้าเลยกลุ่ม LogTime NULL (1753) แล้ว → แถวที่เหลือต้องมี LogTime >= ที่คั่นหน้า
 * (ไม่ต้องคำนวณ OR 6 ชั้นกับแถวเก่าทั้งตาราง)
 */
export const MSSQL_RESCHEDULE_KEYSET_AFTER_PREDICATE = `((
    ${AFTER_LOG_TIME} <= CAST('17530101' AS DATETIME2)
    OR [LogTime] >= ${AFTER_LOG_TIME}
  )
  AND (
    ${MSSQL_RESCHEDULE_LOGTIME_ORDER_EXPR} > ${AFTER_LOG_TIME}
    OR (
      ${MSSQL_RESCHEDULE_LOGTIME_ORDER_EXPR} = ${AFTER_LOG_TIME}
      AND ${MSSQL_RESCHEDULE_SCHEDULE_ID_ORDER_EXPR} > @afterScheduleId
    )
    OR (
      ${MSSQL_RESCHEDULE_LOGTIME_ORDER_EXPR} = ${AFTER_LOG_TIME}
      AND ${MSSQL_RESCHEDULE_SCHEDULE_ID_ORDER_EXPR} = @afterScheduleId
      AND ${MSSQL_RESCHEDULE_SCHEDULE_DT_ORDER_EXPR} > ${AFTER_SCHEDULE_DT}
    )
    OR (
      ${MSSQL_RESCHEDULE_LOGTIME_ORDER_EXPR} = ${AFTER_LOG_TIME}
      AND ${MSSQL_RESCHEDULE_SCHEDULE_ID_ORDER_EXPR} = @afterScheduleId
      AND ${MSSQL_RESCHEDULE_SCHEDULE_DT_ORDER_EXPR} = ${AFTER_SCHEDULE_DT}
      AND ${MSSQL_RESCHEDULE_MODIFIED_ORDER_EXPR} > ${AFTER_MODIFIED}
    )
    OR (
      ${MSSQL_RESCHEDULE_LOGTIME_ORDER_EXPR} = ${AFTER_LOG_TIME}
      AND ${MSSQL_RESCHEDULE_SCHEDULE_ID_ORDER_EXPR} = @afterScheduleId
      AND ${MSSQL_RESCHEDULE_SCHEDULE_DT_ORDER_EXPR} = ${AFTER_SCHEDULE_DT}
      AND ${MSSQL_RESCHEDULE_MODIFIED_ORDER_EXPR} = ${AFTER_MODIFIED}
      AND ${MSSQL_RESCHEDULE_OLD_SCHEDULE_DT_ORDER_EXPR} > ${AFTER_OLD_SCHEDULE_DT}
    )
    OR (
      ${MSSQL_RESCHEDULE_LOGTIME_ORDER_EXPR} = ${AFTER_LOG_TIME}
      AND ${MSSQL_RESCHEDULE_SCHEDULE_ID_ORDER_EXPR} = @afterScheduleId
      AND ${MSSQL_RESCHEDULE_SCHEDULE_DT_ORDER_EXPR} = ${AFTER_SCHEDULE_DT}
      AND ${MSSQL_RESCHEDULE_MODIFIED_ORDER_EXPR} = ${AFTER_MODIFIED}
      AND ${MSSQL_RESCHEDULE_OLD_SCHEDULE_DT_ORDER_EXPR} = ${AFTER_OLD_SCHEDULE_DT}
      AND ${MSSQL_RESCHEDULE_PHYSLOC_ORDER_EXPR} > @afterPhysloc
    )
  ))`;

/**
 * ค่าที่คั่นหน้าเต็มความละเอียดของแถวที่ %%physloc%% = @physloc
 * ใช้ครั้งเดียวตอนแปลง checkpoint รุ่นเก่า (วันที่ละเอียดแค่ ms)
 */
export const MSSQL_RESCHEDULE_ANCHOR_BY_PHYSLOC_SELECT = `
SELECT TOP (2)
  ${KEYSET_CURSOR_ANCHOR_COLUMNS.replace(/^,\s*/, "")}
FROM {{sourceObject}}
WHERE ${RESCHEDULE_ACTIVITY_WHERE}
  AND ${MSSQL_RESCHEDULE_PHYSLOC_ORDER_EXPR} = @physloc;
`.trim();

/** fallback เมื่อ resume checkpoint เก่า (OFFSET) */
export const MSSQL_APPOINTMENT_RESCHEDULES_SELECT = `
SELECT
  ${SELECT_COLUMNS}
FROM {{sourceObject}}
WHERE ${RESCHEDULE_ACTIVITY_WHERE}
  AND (@migrateSrcKeyMin IS NULL OR ${MSSQL_RESCHEDULE_SCHEDULE_ID_ORDER_EXPR} >= @migrateSrcKeyMin)
  AND (@migrateSrcKeyMax IS NULL OR ${MSSQL_RESCHEDULE_SCHEDULE_ID_ORDER_EXPR} <= @migrateSrcKeyMax)
ORDER BY {{orderBy}}
OFFSET @offset ROWS FETCH NEXT @page ROWS ONLY;
`.trim();

/**
 * Keyset ตาม (LogTime, Schedule_ID, Schedule_Datetime, ModifiedDate, Old_Schedule_Datetime) ASC
 * — แยกแถว log ที่คีย์ซ้ำ; cursor เลื่อนด้วย > (เก่า→ใหม่ แถวใหม่อยู่ท้าย)
 */
export function buildMssqlAppointmentReschedulesKeysetSelect(
  orderBy = RESCHEDULE_ORDER_BY,
) {
  return `
SELECT TOP (@page)
  ${SELECT_COLUMNS}
  ${KEYSET_CURSOR_ANCHOR_COLUMNS}
FROM {{sourceObject}}
WHERE ${RESCHEDULE_ACTIVITY_WHERE}
  AND (@migrateSrcKeyMin IS NULL OR ${MSSQL_RESCHEDULE_SCHEDULE_ID_ORDER_EXPR} >= @migrateSrcKeyMin)
  AND (@migrateSrcKeyMax IS NULL OR ${MSSQL_RESCHEDULE_SCHEDULE_ID_ORDER_EXPR} <= @migrateSrcKeyMax)
  AND ${MSSQL_RESCHEDULE_KEYSET_AFTER_PREDICATE}
ORDER BY ${orderBy};
`.trim();
}

/** @deprecated ใช้ buildMssqlAppointmentReschedulesKeysetSelect */
export const MSSQL_APPOINTMENT_RESCHEDULES_KEYSET_SELECT =
  buildMssqlAppointmentReschedulesKeysetSelect();

/** repair-from-log: ดึงตาม log_key (LogTime + Schedule_ID + Schedule_Datetime) */
export const MSSQL_APPOINTMENT_RESCHEDULES_BY_LOG_KEYS_SELECT = `
SELECT
  ${SELECT_COLUMNS}
FROM {{sourceObject}}
WHERE ${RESCHEDULE_ACTIVITY_WHERE}
  AND (
    {{logKeyPredicates}}
  )
ORDER BY ${MSSQL_APPOINTMENT_RESCHEDULES_OFFSET_ORDER_BY};
`.trim();
