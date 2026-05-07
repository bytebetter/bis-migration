/**
 * Mapping: MSSQL dbo.schedule -> Directus appointment payload
 */

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

/**
 * ค่า flag ในฐานเป็น int (0/1) ไม่ใช่ boolean
 */
function toIntFlag(value) {
  const t = nullIfTrimEmpty(value);
  if (t == null) return null;
  if (["1", "true", "True", "Y", "y", "t", "T"].includes(t)) return 1;
  if (["0", "false", "False", "N", "n", "f", "F"].includes(t)) return 0;
  if (/^-?\d+$/.test(t)) return Number.parseInt(t, 10);
  return null;
}

/**
 * รับวันที่จาก MSSQL รูปแบบ "YYYY-MM-DD HH:mm:ss.sss"
 * ถ้าปี >= 2200 ให้ตีความว่าเป็นปี พ.ศ. แล้วลบ 543
 * คืนค่า "YYYY-MM-DDTHH:mm:ss" (ไม่มี timezone)
 */
function toDirectusDateTime(value) {
  const t = nullIfTrimEmpty(value);
  if (t == null || t.length < 10 || t[4] !== "-") return null;

  const yearRaw = Number.parseInt(t.slice(0, 4), 10);
  const month = t.slice(5, 7);
  const day = t.slice(8, 10);
  if (
    !Number.isFinite(yearRaw) ||
    !/^\d{2}$/.test(month) ||
    !/^\d{2}$/.test(day)
  ) {
    return null;
  }

  const year = yearRaw >= 2200 ? yearRaw - 543 : yearRaw;
  const timeRaw = t.slice(10).trim().replace("T", " ");
  if (timeRaw === "") return `${year}-${month}-${day}T00:00:00`;

  const hh = timeRaw.slice(0, 2);
  const mm = timeRaw.slice(3, 5);
  const ss = timeRaw.slice(6, 8);
  if (!/^\d{2}$/.test(hh) || !/^\d{2}$/.test(mm) || !/^\d{2}$/.test(ss)) {
    return `${year}-${month}-${day}T00:00:00`;
  }
  return `${year}-${month}-${day}T${hh}:${mm}:${ss}`;
}

/**
 * map แถวจาก MSSQL schedule ให้เป็น payload สำหรับ Directus appointment
 * หมายเหตุ:
 * - เก็บ Schedule_ID ไปที่ old_db_id เพื่อ trace กลับข้อมูลต้นทาง
 * - ไม่แตะ field system เช่น user_created/date_created
 */
export function mapScheduleRowToAppointment(row) {
  return {
    appointment_datetime: toDirectusDateTime(
      getField(row, "Schedule_Datetime"),
    ),
    appointment_no: toInt(getField(row, "Schedule_Number")),
    prefix: nullIfTrimEmpty(getField(row, "Prefix")),
    first_name: nullIfTrimEmpty(getField(row, "Name")),
    last_name: nullIfTrimEmpty(getField(row, "Surname")),
    payment_type: toInt(getField(row, "Payment_Type")),
    patient_type: toInt(getField(row, "Patient_Type")),
    receive_date: toDirectusDateTime(getField(row, "Receive_Date")),
    old_login_name: nullIfTrimEmpty(getField(row, "LoginName")),
    memo_detail: nullIfTrimEmpty(getField(row, "MemoDetail")),
    /** คอลัมน์ fail ในฐานเป็น integer (เช่น 0/1) ไม่ใช่ boolean */
    fail: toInt(getField(row, "Fail")),
    telephone: nullIfTrimEmpty(getField(row, "Telephone")),
    /** คอลัมน์ inventional ในฐานเป็น integer */
    inventional: toInt(getField(row, "Inventional")),
    biopsy_proc: nullIfTrimEmpty(getField(row, "BiopsyProc")),
    referring_md: toInt(getField(row, "ReferringMD")),
    biopsy_comment: nullIfTrimEmpty(getField(row, "BiopsyComment")),
    biopsy_radiologistg: nullIfTrimEmpty(getField(row, "BiopsyRadiologist")),
    mobile: nullIfTrimEmpty(getField(row, "Mobile")),
    is_online: toIntFlag(getField(row, "IsOnline")),
    have_doc: toIntFlag(getField(row, "HaveDoc")),
    have_cd: toIntFlag(getField(row, "HaveCD")),
    right_id: toInt(getField(row, "Right_ID")),
    location: toInt(getField(row, "Location_ID")),
    patient: null,
    /** Directus มักเก็บ old_db_id เป็น string (varchar) */
    old_db_id: normScheduleId(getField(row, "Schedule_ID")),
  };
}

export function normScheduleId(v) {
  const n = toInt(v);
  return n == null ? null : String(n);
}

/** cache metadata FK ต่อ process — ไม่เก็บ PK ทั้งตาราง parent (โหลดแค่ครั้งเดียว มีแค่ชื่อตาราง/คอลัมน์) */
let cachedAppointmentFkMeta = null;
let cachedOldDbIdIsTextLike = null;
let cachedAppointmentPatientColumn = undefined;
const cachedAllowedFkSetByKey = new Map();

function valueInFkSet(set, v) {
  if (v == null) return true;
  if (set.has(v)) return true;
  if (typeof v === "number" && set.has(String(v))) return true;
  const s = String(v);
  if (/^-?\d+$/.test(s) && set.has(Number.parseInt(s, 10))) return true;
  return false;
}

/**
 * คืน Map<child_col, { sch, rel, pcol }> สำหรับ FK คอลัมน์เดียวบน public.appointment
 */
async function loadAppointmentForeignKeyMeta(pgClient) {
  const cons = await pgClient.query(`
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'public.appointment'::regclass
      AND c.contype = 'f'
      AND array_length(c.conkey, 1) = 1
  `);

  const colToMeta = new Map();

  for (const { conname } of cons.rows) {
    const meta = await pgClient.query(
      `
      SELECT
        child.attname AS child_col,
        n.nspname AS sch,
        p.relname AS rel,
        pa.attname AS pcol
      FROM pg_constraint c
      JOIN pg_attribute child ON child.attrelid = c.conrelid AND child.attnum = c.conkey[1]
      JOIN pg_class p ON p.oid = c.confrelid
      JOIN pg_namespace n ON n.oid = p.relnamespace
      JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
      WHERE c.conname = $1 AND c.contype = 'f'
      `,
      [conname],
    );
    if (meta.rows.length === 0) continue;
    const { child_col, sch, rel, pcol } = meta.rows[0];
    if (!/^[\w]+$/.test(sch) || !/^[\w]+$/.test(rel) || !/^[\w]+$/.test(pcol)) {
      continue;
    }

    colToMeta.set(child_col, { sch, rel, pcol });
  }

  return colToMeta;
}

async function getAppointmentForeignKeyMeta(pgClient) {
  if (cachedAppointmentFkMeta) return cachedAppointmentFkMeta;
  cachedAppointmentFkMeta = await loadAppointmentForeignKeyMeta(pgClient);
  return cachedAppointmentFkMeta;
}

/**
 * โหลดชุดค่า FK ที่อนุญาตจาก parent table แค่ครั้งเดียวต่อ process
 * ช่วยลดคอขวดจากการ query ซ้ำทุก chunk.
 */
async function getCachedAllowedFkSet(pgClient, { sch, rel, pcol }) {
  const key = `${sch}.${rel}.${pcol}`;
  if (cachedAllowedFkSetByKey.has(key)) {
    return cachedAllowedFkSetByKey.get(key);
  }

  const res = await pgClient.query(
    `SELECT "${pcol}" AS v FROM "${sch}"."${rel}"`,
  );
  const set = new Set();
  for (const row of res.rows) {
    const x = row.v;
    if (x == null) continue;
    set.add(x);
    set.add(String(x));
    if (typeof x === "number" || (typeof x === "string" && /^-?\d+$/.test(x))) {
      set.add(Number.parseInt(String(x), 10));
      set.add(Number(x));
    }
  }

  cachedAllowedFkSetByKey.set(key, set);
  return set;
}

/** null ฟิลด์ที่ค่าไม่อยู่ใน parent ตาม FK (ใช้ชุด allowed ต่อ chunk) */
function nullOutInvalidForeignKeysForChunk(payloads, col, allowedSet) {
  for (const mapped of payloads) {
    if (!Object.hasOwn(mapped, col)) continue;
    const v = mapped[col];
    if (v == null) continue;
    if (!valueInFkSet(allowedSet, v)) {
      mapped[col] = null;
    }
  }
}

export function distinctOnScheduleId(mssqlRows) {
  const rowsSorted = [...mssqlRows].sort((a, b) => {
    const ai = toInt(getField(a, "schedule_id"));
    const bi = toInt(getField(b, "schedule_id"));
    if (ai == null && bi == null) return 0;
    if (ai == null) return 1;
    if (bi == null) return -1;
    return ai - bi;
  });
  const seen = new Map();
  for (const row of rowsSorted) {
    const scheduleId = normScheduleId(getField(row, "schedule_id"));
    if (scheduleId == null) continue;
    if (!seen.has(scheduleId)) seen.set(scheduleId, row);
  }
  return Array.from(seen.values());
}

function normPid(v) {
  const t = nullIfTrimEmpty(v);
  return t == null ? null : t;
}

async function resolvePatientIdByPidMap(pgClient, rows) {
  const pids = Array.from(
    new Set(
      rows
        .map((r) => normPid(getField(r, "pid") ?? getField(r, "PID")))
        .filter((v) => v != null),
    ),
  );
  if (pids.length === 0) return new Map();

  const res = await pgClient.query(
    `
    SELECT
      id,
      NULLIF(btrim(pid::text), '') AS pid_text,
      NULLIF(btrim(old_db_id::text), '') AS old_db_id_text
    FROM public.patient_info
    WHERE pid::text = ANY($1::text[])
       OR old_db_id::text = ANY($1::text[])
    `,
    [pids],
  );

  const map = new Map();
  for (const row of res.rows) {
    if (row.pid_text != null && !map.has(row.pid_text)) {
      map.set(row.pid_text, row.id);
    }
    if (row.old_db_id_text != null && !map.has(row.old_db_id_text)) {
      map.set(row.old_db_id_text, row.id);
    }
  }
  return map;
}

async function isOldDbIdTextLike(pgClient) {
  if (cachedOldDbIdIsTextLike != null) return cachedOldDbIdIsTextLike;
  const r = await pgClient.query(`
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'appointment'
      AND column_name = 'old_db_id'
    LIMIT 1
  `);
  const dt = r.rows?.[0]?.data_type ?? "";
  cachedOldDbIdIsTextLike = dt === "character varying" || dt === "text";
  return cachedOldDbIdIsTextLike;
}

async function resolveAppointmentPatientColumn(pgClient) {
  if (cachedAppointmentPatientColumn !== undefined) {
    return cachedAppointmentPatientColumn;
  }
  const r = await pgClient.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'appointment'
      AND column_name IN ('patient', 'patient_info', 'patient_id')
    ORDER BY CASE column_name
      WHEN 'patient_info' THEN 0
      WHEN 'patient' THEN 1
      WHEN 'patient_id' THEN 2
      ELSE 99
    END
    LIMIT 1
  `);
  cachedAppointmentPatientColumn = r.rows?.[0]?.column_name ?? null;
  return cachedAppointmentPatientColumn;
}

/**
 * upsert แบบลบแล้วแทรกในช่วง chunk
 */
export async function runAppointmentChunkPostLoad(pgClient, mssqlRows) {
  const rows = distinctOnScheduleId(mssqlRows);
  if (rows.length === 0) return;

  const oldDbIds = rows
    .map((r) => normScheduleId(getField(r, "schedule_id")))
    .filter((v) => v != null);

  const oldDbIdTextLike = await isOldDbIdTextLike(pgClient);
  await pgClient.query(
    oldDbIdTextLike
      ? "DELETE FROM public.appointment WHERE old_db_id = ANY($1::text[])"
      : "DELETE FROM public.appointment WHERE old_db_id::text = ANY($1::text[])",
    [oldDbIds],
  );

  const fkMeta = await getAppointmentForeignKeyMeta(pgClient);
  const patientColumn = await resolveAppointmentPatientColumn(pgClient);
  const payloads = rows.map((r) => mapScheduleRowToAppointment(r));
  const patientIdByPid = await resolvePatientIdByPidMap(pgClient, rows);
  for (let i = 0; i < rows.length; i++) {
    const pid = normPid(getField(rows[i], "pid") ?? getField(rows[i], "PID"));
    const patientId = pid == null ? null : (patientIdByPid.get(pid) ?? null);
    if (patientColumn) {
      payloads[i][patientColumn] =
        patientId == null || Number(patientId) === 0 ? null : Number(patientId);
    }
    delete payloads[i].patient;
  }

  if (payloads.length > 0 && fkMeta.size > 0) {
    const sample = payloads[0];
    for (const [col, meta] of fkMeta) {
      if (!Object.hasOwn(sample, col)) continue;
      const distinct = [];
      const seen = new Set();
      for (const p of payloads) {
        const v = p[col];
        if (v == null) continue;
        const key = typeof v === "number" ? `n:${v}` : `s:${String(v)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        distinct.push(v);
      }
      if (distinct.length === 0) continue;
      const allowed = await getCachedAllowedFkSet(pgClient, meta);
      nullOutInvalidForeignKeysForChunk(payloads, col, allowed);
    }
  }
  const arrays = {
    appointment_datetime: [],
    appointment_no: [],
    prefix: [],
    first_name: [],
    last_name: [],
    payment_type: [],
    patient_type: [],
    receive_date: [],
    old_login_name: [],
    memo_detail: [],
    fail: [],
    telephone: [],
    inventional: [],
    biopsy_proc: [],
    referring_md: [],
    biopsy_comment: [],
    biopsy_radiologistg: [],
    mobile: [],
    is_online: [],
    have_doc: [],
    have_cd: [],
    right_id: [],
    location: [],
    old_db_id: [],
  };
  if (patientColumn) arrays[patientColumn] = [];

  for (const item of payloads) {
    arrays.appointment_datetime.push(item.appointment_datetime);
    arrays.appointment_no.push(item.appointment_no);
    arrays.prefix.push(item.prefix);
    arrays.first_name.push(item.first_name);
    arrays.last_name.push(item.last_name);
    arrays.payment_type.push(item.payment_type);
    arrays.patient_type.push(item.patient_type);
    arrays.receive_date.push(item.receive_date);
    arrays.old_login_name.push(item.old_login_name);
    arrays.memo_detail.push(item.memo_detail);
    arrays.fail.push(item.fail);
    arrays.telephone.push(item.telephone);
    arrays.inventional.push(item.inventional);
    arrays.biopsy_proc.push(item.biopsy_proc);
    arrays.referring_md.push(item.referring_md);
    arrays.biopsy_comment.push(item.biopsy_comment);
    arrays.biopsy_radiologistg.push(item.biopsy_radiologistg);
    arrays.mobile.push(item.mobile);
    arrays.is_online.push(item.is_online);
    arrays.have_doc.push(item.have_doc);
    arrays.have_cd.push(item.have_cd);
    arrays.right_id.push(item.right_id);
    arrays.location.push(item.location);
    if (patientColumn) arrays[patientColumn].push(item[patientColumn] ?? null);
    arrays.old_db_id.push(item.old_db_id);
  }

  const insertDefs = [
    ["appointment_datetime", "timestamp[]", arrays.appointment_datetime],
    ["appointment_no", "int4[]", arrays.appointment_no],
    ["prefix", "text[]", arrays.prefix],
    ["first_name", "text[]", arrays.first_name],
    ["last_name", "text[]", arrays.last_name],
    ["payment_type", "int4[]", arrays.payment_type],
    ["patient_type", "int4[]", arrays.patient_type],
    ["receive_date", "timestamp[]", arrays.receive_date],
    ["old_login_name", "text[]", arrays.old_login_name],
    ["memo_detail", "text[]", arrays.memo_detail],
    ["fail", "int4[]", arrays.fail],
    ["telephone", "text[]", arrays.telephone],
    ["inventional", "int4[]", arrays.inventional],
    ["biopsy_proc", "text[]", arrays.biopsy_proc],
    ["referring_md", "int4[]", arrays.referring_md],
    ["biopsy_comment", "text[]", arrays.biopsy_comment],
    ["biopsy_radiologistg", "text[]", arrays.biopsy_radiologistg],
    ["mobile", "text[]", arrays.mobile],
    ["is_online", "int4[]", arrays.is_online],
    ["have_doc", "int4[]", arrays.have_doc],
    ["have_cd", "int4[]", arrays.have_cd],
    ["right_id", "int4[]", arrays.right_id],
    ["location", "int4[]", arrays.location],
    ...(patientColumn
      ? [[patientColumn, "int4[]", arrays[patientColumn]]]
      : []),
    ["old_db_id", "text[]", arrays.old_db_id],
  ];
  const colList = insertDefs.map(([col]) => col).join(", ");
  const unnestList = insertDefs
    .map(([, pgType], idx) => `$${idx + 1}::${pgType}`)
    .join(", ");
  const params = insertDefs.map(([, , arr]) => arr);
  await pgClient.query(
    `
    INSERT INTO public.appointment (${colList})
    SELECT * FROM unnest(${unnestList})
    `,
    params,
  );
}

export async function syncAppointmentIdSequence(pgClient) {
  await pgClient.query(`
    SELECT setval(
      pg_get_serial_sequence('public.appointment', 'id'),
      COALESCE((SELECT MAX(id) + 1 FROM public.appointment), 1),
      false
    )
    WHERE pg_get_serial_sequence('public.appointment', 'id') IS NOT NULL;
  `);
}

export async function resetAppointmentIdSequenceIfEmpty(pgClient) {
  await pgClient.query(`
    WITH cnt AS (
      SELECT COUNT(*)::bigint AS c FROM public.appointment
    )
    SELECT setval(
      pg_get_serial_sequence('public.appointment', 'id'),
      1,
      false
    )
    FROM cnt
    WHERE cnt.c = 0
      AND pg_get_serial_sequence('public.appointment', 'id') IS NOT NULL;
  `);
}

export const SCHEDULE_TO_APPOINTMENT_FIELD_MAP = [
  ["Schedule_Datetime", "appointment_datetime"],
  ["Schedule_Number", "appointment_no"],
  ["Prefix", "prefix"],
  ["Name", "first_name"],
  ["Surname", "last_name"],
  ["Payment_Type", "payment_type"],
  ["Patient_Type", "patient_type"],
  ["Receive_Date", "receive_date"],
  ["LoginName", "old_login_name"],
  ["MemoDetail", "memo_detail"],
  ["Fail", "fail"],
  ["Telephone", "telephone"],
  ["Inventional", "inventional"],
  ["BiopsyProc", "biopsy_proc"],
  ["ReferringMD", "referring_md"],
  ["BiopsyComment", "biopsy_comment"],
  ["BiopsyRadiologist", "biopsy_radiologistg"],
  ["Mobile", "mobile"],
  ["IsOnline", "is_online"],
  ["HaveDoc", "have_doc"],
  ["HaveCD", "have_cd"],
  ["Right_ID", "right_id"],
  ["Location_ID", "location"],
  ["PID", "patient"],
  ["Schedule_ID", "old_db_id"],
];
