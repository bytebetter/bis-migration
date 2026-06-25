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

const RESCHEDULE_ORDER_BY = `${MSSQL_RESCHEDULE_LOGTIME_ORDER_EXPR} ASC, ${MSSQL_RESCHEDULE_SCHEDULE_ID_ORDER_EXPR} ASC, ${MSSQL_RESCHEDULE_SCHEDULE_DT_ORDER_EXPR} ASC, ${MSSQL_RESCHEDULE_MODIFIED_ORDER_EXPR} ASC, ${MSSQL_RESCHEDULE_OLD_SCHEDULE_DT_ORDER_EXPR} ASC`;

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

const RESCHEDULE_ACTIVITY_WHERE = `[Activity] = N'${MSSQL_APPOINTMENT_RESCHEDULE_ACTIVITY}'`;

/** ORDER BY เดียวกับ keyset — ให้ OFFSET resume ตรงกับลำดับ keyset */
export const MSSQL_APPOINTMENT_RESCHEDULES_OFFSET_ORDER_BY = RESCHEDULE_ORDER_BY;

/**
 * ค่าเลื่อน cursor ต้องมาจาก expression เดียวกับด้านบน — อย่าอ่านจาก CONVERT VARCHAR ใน OUTPUT อย่างเดียว
 */
const KEYSET_CURSOR_ANCHOR_COLUMNS = `
  , ${MSSQL_RESCHEDULE_LOGTIME_ORDER_EXPR} AS ktv_log_time_ord
  , ${MSSQL_RESCHEDULE_SCHEDULE_ID_ORDER_EXPR} AS ktv_schedule_id_ord
  , ${MSSQL_RESCHEDULE_SCHEDULE_DT_ORDER_EXPR} AS ktv_schedule_dt_ord
  , ${MSSQL_RESCHEDULE_MODIFIED_ORDER_EXPR} AS ktv_modified_ord
  , ${MSSQL_RESCHEDULE_OLD_SCHEDULE_DT_ORDER_EXPR} AS ktv_old_schedule_dt_ord
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
  AND (
    ${MSSQL_RESCHEDULE_LOGTIME_ORDER_EXPR} > @afterLogTime
    OR (
      ${MSSQL_RESCHEDULE_LOGTIME_ORDER_EXPR} = @afterLogTime
      AND ${MSSQL_RESCHEDULE_SCHEDULE_ID_ORDER_EXPR} > @afterScheduleId
    )
    OR (
      ${MSSQL_RESCHEDULE_LOGTIME_ORDER_EXPR} = @afterLogTime
      AND ${MSSQL_RESCHEDULE_SCHEDULE_ID_ORDER_EXPR} = @afterScheduleId
      AND ${MSSQL_RESCHEDULE_SCHEDULE_DT_ORDER_EXPR} > @afterScheduleDatetime
    )
    OR (
      ${MSSQL_RESCHEDULE_LOGTIME_ORDER_EXPR} = @afterLogTime
      AND ${MSSQL_RESCHEDULE_SCHEDULE_ID_ORDER_EXPR} = @afterScheduleId
      AND ${MSSQL_RESCHEDULE_SCHEDULE_DT_ORDER_EXPR} = @afterScheduleDatetime
      AND ${MSSQL_RESCHEDULE_MODIFIED_ORDER_EXPR} > @afterModifiedDate
    )
    OR (
      ${MSSQL_RESCHEDULE_LOGTIME_ORDER_EXPR} = @afterLogTime
      AND ${MSSQL_RESCHEDULE_SCHEDULE_ID_ORDER_EXPR} = @afterScheduleId
      AND ${MSSQL_RESCHEDULE_SCHEDULE_DT_ORDER_EXPR} = @afterScheduleDatetime
      AND ${MSSQL_RESCHEDULE_MODIFIED_ORDER_EXPR} = @afterModifiedDate
      AND ${MSSQL_RESCHEDULE_OLD_SCHEDULE_DT_ORDER_EXPR} > @afterOldScheduleDatetime
    )
  )
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
