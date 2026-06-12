import { ENSURE_PLACEHOLDER_APPOINTMENT_ENABLED } from "./placeholderMigrateFlags.mjs";

const INT_RE = /^-?\d+$/;

/** ชื่อใน public.appointment (first_name / last_name ไม่ใช่ _th) */
export const PLACEHOLDER_APPOINTMENT_FIRST_NAME = "ไม่ทราบชื่อ";

/** แถว appointment ที่สร้างจาก ensurePlaceholderAppointment */
export function isPlaceholderAppointmentRow(row) {
  return row?.first_name === PLACEHOLDER_APPOINTMENT_FIRST_NAME;
}

/**
 * ตารางที่อ้าง appointment ผ่าน schedule_id → old_db_id และสร้าง placeholder ถ้าไม่พบ
 */
export const TABLES_ENSURE_PLACEHOLDER_APPOINTMENT = ["examination"];

function clampText255(v) {
  const t = v == null ? "" : String(v).trim();
  if (t === "") return null;
  return t.length <= 255 ? t : t.slice(0, 255);
}

/** last_name = "Schedule ID {scheduleId}" */
export function placeholderAppointmentLastName(scheduleId) {
  const prefix = "Schedule ID ";
  const p = clampText255(scheduleId) ?? String(scheduleId ?? "");
  const maxLen = 255 - prefix.length;
  const body = p.length <= maxLen ? p : p.slice(0, maxLen);
  return `${prefix}${body}`;
}

/** เทียบ appointment.normScheduleId / examination toStrictInt → string */
export function normScheduleOldDbId(v) {
  if (v == null) return null;
  const t = String(v)
    .replace(/^\uFEFF/, "")
    .trim();
  if (t === "" || !INT_RE.test(t)) return null;
  return String(Number.parseInt(t, 10));
}

/**
 * สร้าง public.appointment ชั่วคราวเมื่อยังไม่มี old_db_id = Schedule_ID
 * @returns {{ inserted: number }}
 */
export async function ensurePlaceholderAppointment(pgClient, rawScheduleIds) {
  if (!ENSURE_PLACEHOLDER_APPOINTMENT_ENABLED) return { inserted: 0 };

  const keys = [
    ...new Set(
      (rawScheduleIds ?? [])
        .map((k) => normScheduleOldDbId(k))
        .filter((k) => k != null),
    ),
  ];
  if (keys.length === 0) return { inserted: 0 };

  const { rows: found } = await pgClient.query(
    `
    SELECT DISTINCT u.k
    FROM unnest($1::text[]) AS u(k)
    WHERE EXISTS (
      SELECT 1 FROM public.appointment a
      WHERE btrim(a.old_db_id::text) = u.k
    )
    `,
    [keys],
  );
  const foundSet = new Set(found.map((r) => r.k));
  const missing = keys.filter((k) => !foundSet.has(k));
  if (missing.length === 0) return { inserted: 0 };

  const aOld = [];
  const aFn = [];
  const aLn = [];
  for (const k of missing) {
    aOld.push(clampText255(k));
    aFn.push(PLACEHOLDER_APPOINTMENT_FIRST_NAME);
    aLn.push(placeholderAppointmentLastName(k));
  }

  const ins = await pgClient.query(
    `
    INSERT INTO public.appointment (old_db_id, first_name, last_name)
    SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
      AS t(old_db_id, first_name, last_name)
    RETURNING id
    `,
    [aOld, aFn, aLn],
  );

  await pgClient.query(`
    SELECT setval(
      pg_get_serial_sequence('public.appointment', 'id'),
      COALESCE((SELECT MAX(id) + 1 FROM public.appointment), 1),
      false
    )
    WHERE pg_get_serial_sequence('public.appointment', 'id') IS NOT NULL
  `);

  return { inserted: ins.rowCount ?? ins.rows?.length ?? 0 };
}
