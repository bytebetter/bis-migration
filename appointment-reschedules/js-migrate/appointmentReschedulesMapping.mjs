/**
 * Mapping: dbo.SCHEDULE_LOG (Activity = ย้ายวันนัด) -> public.appointment_reschedules
 */

import { sourceRawNonempty } from "../../shared/js-migrate/fieldIssueLog.mjs";

function getField(row, key) {
  return row[key] ?? row[key.toLowerCase()] ?? row[key.toUpperCase()];
}

function nullIfTrimEmpty(value) {
  if (value == null) return null;
  const t = String(value).trim();
  return t === "" ? null : t;
}

function toInt(value) {
  const t = nullIfTrimEmpty(value);
  if (t == null || !/^-?\d+$/.test(t)) return null;
  return Number.parseInt(t, 10);
}

export function normScheduleId(v) {
  const n = toInt(v);
  return n == null ? null : String(n);
}

function formatPgTimestampParts(yyyy, m, d, hh, mi, ss) {
  return `${yyyy}-${m}-${d} ${hh}:${mi}:${ss}`;
}

function mssqlDateTimeToIsoLikeString(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const pad = (n) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}T${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`;
  }
  const t = nullIfTrimEmpty(v);
  return t == null || t === "" ? null : t;
}

/**
 * MSSQL datetime -> "YYYY-MM-DD HH:mm:ss" (พ.ศ. >= 2200 -> ค.ศ., ตัด Z)
 * รองรับ CONVERT(..., 126) เช่น 2020-01-15T10:30:00 และ 2020-01-15 10:30:00
 */
export function toPgTimestamp(v) {
  const t = mssqlDateTimeToIsoLikeString(v);
  if (t == null || t.length < 10 || t[4] !== "-") return null;

  const y = Number.parseInt(t.slice(0, 4), 10);
  const m = t.slice(5, 7);
  const d = t.slice(8, 10);
  if (!Number.isFinite(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d)) {
    return null;
  }

  const yyyy = y >= 2200 ? y - 543 : y;
  const timeRaw = t.slice(10).trim().replace(/^T/i, "").replace(/Z$/i, "");
  if (timeRaw === "")
    return formatPgTimestampParts(yyyy, m, d, "00", "00", "00");

  const timeCore = timeRaw.split(".")[0];
  const hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(timeCore);
  if (!hm) return formatPgTimestampParts(yyyy, m, d, "00", "00", "00");

  const hh = hm[1].padStart(2, "0");
  const mi = hm[2];
  const ss = (hm[3] ?? "00").padStart(2, "0");
  if (
    Number.parseInt(hh, 10) > 23 ||
    Number.parseInt(mi, 10) > 59 ||
    Number.parseInt(ss, 10) > 59
  ) {
    return formatPgTimestampParts(yyyy, m, d, "00", "00", "00");
  }
  return formatPgTimestampParts(yyyy, m, d, hh, mi, ss);
}

/** @param {string|null} pgTimestamp */
export function clockFromPgTimestamp(pgTimestamp) {
  const t = nullIfTrimEmpty(pgTimestamp);
  if (t == null) return null;
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):\d{2}$/.exec(t);
  if (!m) return null;
  return `${m[2]}:${m[3]}`;
}

function normalizeSlotLabel(slot) {
  const t = nullIfTrimEmpty(slot);
  if (t == null) return null;
  const parts = t.split(":");
  if (parts.length < 2) return t;
  const hh = parts[0].padStart(2, "0");
  const mm = parts[1].padStart(2, "0");
  return `${hh}:${mm}`;
}

let cachedSlotIdByClock = null;
let cachedAppointmentIdByOldDbId = null;
let cachedHasOldAppointmentDatetimeColumn = null;

/**
 * คอลัมน์ old_appointment_datetime เพิ่งเพิ่มใน Directus — ฐาน clone เก่าอาจยังไม่มี
 * เช็คครั้งเดียวต่อ process แล้วใส่คอลัมน์ใน INSERT เฉพาะเมื่อปลายทางมีจริง
 */
async function hasOldAppointmentDatetimeColumn(pgClient) {
  if (cachedHasOldAppointmentDatetimeColumn != null) {
    return cachedHasOldAppointmentDatetimeColumn;
  }
  const r = await pgClient.query(`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'appointment_reschedules'
      AND column_name = 'old_appointment_datetime'
    LIMIT 1
  `);
  cachedHasOldAppointmentDatetimeColumn = (r.rowCount ?? 0) > 0;
  return cachedHasOldAppointmentDatetimeColumn;
}

async function loadSlotIdByClock(pgClient) {
  const { rows } = await pgClient.query(`
    SELECT id, slot
    FROM public.time_slot
    WHERE COALESCE(is_bx_time, false) = false
    ORDER BY id ASC
  `);
  const map = new Map();
  for (const row of rows) {
    const key = normalizeSlotLabel(row.slot);
    if (key == null || map.has(key)) continue;
    map.set(key, Number(row.id));
  }
  return map;
}

async function getSlotIdByClock(pgClient) {
  if (cachedSlotIdByClock) return cachedSlotIdByClock;
  cachedSlotIdByClock = await loadSlotIdByClock(pgClient);
  return cachedSlotIdByClock;
}

async function loadAppointmentIdByOldDbId(pgClient) {
  const { rows } = await pgClient.query(`
    SELECT id, btrim(old_db_id::text) AS k
    FROM public.appointment
    WHERE old_db_id IS NOT NULL AND btrim(old_db_id::text) <> ''
  `);
  const map = new Map();
  for (const row of rows) {
    if (row.k == null) continue;
    const prev = map.get(row.k);
    if (prev == null || row.id < prev) map.set(row.k, Number(row.id));
  }
  return map;
}

async function getAppointmentIdByOldDbId(pgClient) {
  if (cachedAppointmentIdByOldDbId) return cachedAppointmentIdByOldDbId;
  cachedAppointmentIdByOldDbId = await loadAppointmentIdByOldDbId(pgClient);
  return cachedAppointmentIdByOldDbId;
}

export function rescheduleLogKey(row) {
  const logTime = nullIfTrimEmpty(getField(row, "log_time"));
  const scheduleId = normScheduleId(getField(row, "schedule_id"));
  const schedDt = nullIfTrimEmpty(getField(row, "schedule_datetime"));
  if (logTime == null) return null;
  return `${scheduleId ?? ""}|${logTime}|${schedDt ?? ""}`;
}

export function mapScheduleLogRowToReschedule(row) {
  const appointmentDatetime = toPgTimestamp(getField(row, "schedule_datetime"));
  const clock = clockFromPgTimestamp(appointmentDatetime);
  return {
    appointment_datetime: appointmentDatetime,
    clock,
    schedule_id: normScheduleId(getField(row, "schedule_id")),
    log_time: toPgTimestamp(getField(row, "log_time")),
    old_appointment_datetime: toPgTimestamp(
      getField(row, "old_schedule_datetime"),
    ),
    appointed_by: null,
    time_slot: null,
    appointment: null,
  };
}

function collectFieldIssues(row, mapped, ctx) {
  const issues = [];
  const logKey = rescheduleLogKey(row);

  const srcSched = getField(row, "schedule_datetime");
  if (sourceRawNonempty(srcSched) && mapped.appointment_datetime == null) {
    issues.push({
      field: "appointment_datetime",
      reason: "datetime_parse_failed",
      message: "Schedule_Datetime แปลงไม่ได้",
      source_raw: srcSched,
      mapped: null,
    });
  }

  const srcOldSched = getField(row, "old_schedule_datetime");
  if (
    sourceRawNonempty(srcOldSched) &&
    mapped.old_appointment_datetime == null
  ) {
    issues.push({
      field: "old_appointment_datetime",
      reason: "datetime_parse_failed",
      message: "Old_Schedule_Datetime แปลงไม่ได้",
      source_raw: srcOldSched,
      mapped: null,
    });
  }

  if (mapped.clock != null && mapped.time_slot == null) {
    issues.push({
      field: "time_slot",
      reason: "time_slot_not_found",
      message: `ไม่พบ time_slot.slot ที่ตรงกับเวลา ${mapped.clock}`,
      source_raw: mapped.clock,
      mapped: null,
    });
  }

  if (logKey == null) {
    issues.push({
      field: "_record",
      reason: "missing_log_key",
      message: "ไม่มี LogTime สำหรับระบุแถว",
      source_raw: getField(row, "log_time"),
      mapped: null,
    });
  }

  return issues;
}

async function bulkInsertReschedules(
  pgClient,
  payloads,
  includeOldAppointmentDatetime,
) {
  if (payloads.length === 0) return 0;
  const appointmentDatetime = [];
  const timeSlot = [];
  const appointment = [];
  const appointedBy = [];
  const oldAppointmentDatetime = [];
  for (const p of payloads) {
    appointmentDatetime.push(p.appointment_datetime);
    timeSlot.push(p.time_slot);
    appointment.push(p.appointment);
    appointedBy.push(p.appointed_by);
    oldAppointmentDatetime.push(p.old_appointment_datetime ?? null);
  }

  /** @type {[string, string, unknown[]][]} */
  const defs = [
    ["appointment_datetime", "timestamp[]", appointmentDatetime],
    ["time_slot", "int4[]", timeSlot],
    ["appointment", "int8[]", appointment],
    ["appointed_by", "uuid[]", appointedBy],
    ...(includeOldAppointmentDatetime
      ? [["old_appointment_datetime", "timestamp[]", oldAppointmentDatetime]]
      : []),
  ];
  const colList = defs.map(([col]) => col).join(", ");
  const unnestList = defs
    .map(([, pgType], idx) => `$${idx + 1}::${pgType}`)
    .join(", ");
  const ins = await pgClient.query(
    `
    INSERT INTO public.appointment_reschedules (${colList})
    SELECT * FROM unnest(${unnestList})
    `,
    defs.map(([, , arr]) => arr),
  );
  return ins.rowCount ?? payloads.length;
}

/**
 * @returns {{ failedLogKeys: string[], fieldIssues: object|null, rowsWritten: number }}
 */
export async function runAppointmentReschedulesChunkPostLoad(
  pgClient,
  mssqlRows,
) {
  if (mssqlRows.length === 0) {
    return { failedLogKeys: [], fieldIssues: null, rowsWritten: 0 };
  }

  const slotByClock = await getSlotIdByClock(pgClient);
  const appointmentByOldDbId = await getAppointmentIdByOldDbId(pgClient);
  const includeOldAppointmentDatetime =
    await hasOldAppointmentDatetimeColumn(pgClient);

  const failingLogKeySet = new Set();
  let totalFieldIssueCount = 0;
  /** @type {Map<string, object>} */
  const recordsWithIssues = new Map();

  function recordIssues(logKey, meta, fieldIssues) {
    if (fieldIssues.length === 0 || logKey == null) return;
    failingLogKeySet.add(logKey);
    totalFieldIssueCount += fieldIssues.length;
    let rec = recordsWithIssues.get(logKey);
    if (!rec) {
      rec = {
        log_key: logKey,
        schedule_id: meta.scheduleId ?? null,
        log_time: meta.logTime ?? null,
        fieldIssues: [],
      };
      recordsWithIssues.set(logKey, rec);
    }
    rec.fieldIssues.push(...fieldIssues);
  }

  const payloads = [];
  for (const row of mssqlRows) {
    const mapped = mapScheduleLogRowToReschedule(row);
    const logKey = rescheduleLogKey(row);
    const scheduleId = mapped.schedule_id;

    if (mapped.clock != null) {
      mapped.time_slot = slotByClock.get(mapped.clock) ?? null;
    }
    if (scheduleId != null) {
      const resolved = appointmentByOldDbId.get(scheduleId);
      mapped.appointment = resolved == null ? null : resolved;
    }

    recordIssues(
      logKey,
      {
        scheduleId,
        logTime: mapped.log_time,
      },
      collectFieldIssues(row, mapped, {}),
    );

    payloads.push({
      appointment_datetime: mapped.appointment_datetime,
      time_slot: mapped.time_slot,
      appointment: mapped.appointment,
      appointed_by: mapped.appointed_by,
      old_appointment_datetime: mapped.old_appointment_datetime,
    });
  }

  // เก็บทุกแถว log จาก MSSQL: insert ตรงๆ ทุกแถว ไม่ dedupe ตาม natural key
  // (appointment, appointment_datetime) — ตารางปลายทางไม่มี unique constraint
  // บนคู่นั้น (มีแค่ PK id) จึงมีแถวซ้ำได้ตามจำนวน log จริง
  const rowsWritten = await bulkInsertReschedules(
    pgClient,
    payloads,
    includeOldAppointmentDatetime,
  );

  return {
    failedLogKeys: [...failingLogKeySet].sort(),
    fieldIssues:
      totalFieldIssueCount > 0
        ? {
            totalFieldIssueCount,
            rowsWritten,
            records: [...recordsWithIssues.values()],
          }
        : null,
    rowsWritten,
  };
}

export async function syncAppointmentReschedulesIdSequence(pgClient) {
  await pgClient.query(`
    SELECT setval(
      pg_get_serial_sequence('public.appointment_reschedules', 'id'),
      COALESCE((SELECT MAX(id) + 1 FROM public.appointment_reschedules), 1),
      false
    )
    WHERE pg_get_serial_sequence('public.appointment_reschedules', 'id') IS NOT NULL;
  `);
}

export async function resetAppointmentReschedulesIdSequenceIfEmpty(pgClient) {
  await pgClient.query(`
    WITH cnt AS (
      SELECT COUNT(*)::bigint AS c FROM public.appointment_reschedules
    )
    SELECT setval(
      pg_get_serial_sequence('public.appointment_reschedules', 'id'),
      1,
      false
    )
    FROM cnt
    WHERE cnt.c = 0
      AND pg_get_serial_sequence('public.appointment_reschedules', 'id') IS NOT NULL;
  `);
}

export async function warmupAppointmentReschedulesLookups(pgClient) {
  await Promise.all([
    getSlotIdByClock(pgClient),
    getAppointmentIdByOldDbId(pgClient),
  ]);
}

export function invalidateAppointmentReschedulesLookupCache() {
  cachedSlotIdByClock = null;
  cachedAppointmentIdByOldDbId = null;
  cachedHasOldAppointmentDatetimeColumn = null;
}
