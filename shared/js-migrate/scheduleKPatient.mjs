/**
 * คนไข้ K จากนัดที่ไม่มี PID (dbo.schedule) — คนไข้ใหม่ที่จองนัดไว้ก่อนลงทะเบียน
 *
 * ระบบใหม่สร้างคนไข้แบบนี้ผ่าน flow [id-36]: created_by_queue_type = 'K' → pid = 'K' + id
 * migration insert ตรงไม่ผ่าน Directus (flow ไม่ทำงาน) จึงจอง id จาก sequence แล้วใส่ pid เอง
 *
 * ตัวระบุว่าเป็น K ที่ migration สร้าง: pid = 'K' || id และ old_db_id = pid
 * (แถวที่ระบบใหม่สร้างเอง old_db_id ว่าง → ไม่ถูกจับคู่ซ้ำ / ไม่ถูกลบ)
 *
 * - ทุกนัดที่ PID ว่างได้ K รวมแถววันหยุด/กันช่อง ("วันหยุด ...", "-", "OFF") — user สั่งไม่กรอง (2026-10-20)
 *   เพราะแยกวันหยุดออกจากคนจริงด้วยชื่อไม่ได้แน่นอน (พิมพ์วันหยุดลงช่อง prefix/ชื่อ/นามสกุลปนกัน)
 * - ชื่อ + นามสกุล + เบอร์ตรงกัน = คนเดียวกัน ใช้ K เดียวกัน (ไม่มีเบอร์ → สร้างใหม่ทุกนัด)
 * - ต้นทางเติม PID ทีหลัง / exam ของนัดนั้นมีคนไข้จริง → ย้ายนัดไปผูกคนไข้จริง แล้วลบ K ที่ไม่มีอะไรอ้างถึง
 */
/** เบอร์สั้นกว่านี้ (บ้าน 9 หลัก / มือถือ 10 หลัก) ไม่ใช้ระบุตัวคน */
const MIN_PHONE_DIGITS = 9;

/** SQL boolean: แถว patient_info (alias) เป็นคนไข้ K ที่ migration สร้างจากนัด */
export function migrationKPatientSql(alias) {
  return `(${alias}.pid::text = 'K' || ${alias}.id::text AND ${alias}.old_db_id::text = ${alias}.pid::text)`;
}

/** ตัด BOM + ช่องว่างหัวท้าย + ยุบช่องว่างซ้อน — ว่างคืน null */
export function cleanPersonName(v) {
  if (v == null) return null;
  const t = String(v)
    .replace(/^﻿/, "")
    .replace(/\s+/g, " ")
    .trim();
  return t === "" ? null : t;
}

function clampText255(v) {
  if (v == null) return null;
  const t = String(v).trim();
  if (t === "") return null;
  return t.length <= 255 ? t : t.slice(0, 255);
}

function phoneDigits(v) {
  const d = v == null ? "" : String(v).replace(/\D/g, "");
  return d.length >= MIN_PHONE_DIGITS ? d : null;
}

/**
 * คีย์คนเดียวกัน: ชื่อ + นามสกุล + เบอร์ (มือถือก่อน ไม่มีค่อยใช้เบอร์บ้าน) — นามสกุลว่างก็ได้ (เทียบเป็นว่าง)
 * ใช้ค่าหลังแปลงเป็นค่าที่ลง patient_info แล้ว — คีย์ของนัดใหม่กับของ K ในฐานจึงคำนวณแบบเดียวกัน
 * @returns {string | null} null = ไม่มีชื่อหรือไม่มีเบอร์ ไม่จับคู่กับใคร
 */
export function kPatientMatchKey({ first_name_th, last_name_th, mobile_phone, phone_home }) {
  if (first_name_th == null) return null;
  const phone = phoneDigits(mobile_phone) ?? phoneDigits(phone_home);
  if (phone == null) return null;
  return `${first_name_th}\u0001${last_name_th ?? ""}\u0001${phone}`;
}

/**
 * ค่าที่ลง patient_info จากแถว schedule (getField ของผู้เรียก)
 * Mobile = เบอร์โทรศัพท์ → mobile_phone, Telephone = โทรศัพท์บ้าน → phone_home (ตามหัวคอลัมน์รายงานนัดของระบบใหม่)
 */
export function mapScheduleRowToKPatient({ prefix, name, surname, mobile, telephone }) {
  return {
    prefix_th: clampText255(cleanPersonName(prefix)),
    first_name_th: clampText255(cleanPersonName(name)),
    last_name_th: clampText255(cleanPersonName(surname)),
    mobile_phone: clampText255(mobile),
    phone_home: clampText255(telephone),
  };
}

let cachedHasQueueTypeColumn;

async function hasCreatedByQueueTypeColumn(pgClient) {
  if (cachedHasQueueTypeColumn !== undefined) return cachedHasQueueTypeColumn;
  const r = await pgClient.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'patient_info'
      AND column_name = 'created_by_queue_type'
  `);
  cachedHasQueueTypeColumn = r.rows.length > 0;
  return cachedHasQueueTypeColumn;
}

/**
 * หา/สร้างคนไข้ K ให้แต่ละนัด
 * @param {import("pg").PoolClient} pgClient
 * @param {ReturnType<typeof mapScheduleRowToKPatient>[]} patients ลำดับเดียวกับนัด
 * @returns {Promise<{ ids: number[], created: number, reused: number }>} ids ลำดับเดียวกับ patients
 */
export async function ensureScheduleKPatients(pgClient, patients) {
  const ids = new Array(patients.length).fill(null);
  if (patients.length === 0) return { ids, created: 0, reused: 0 };

  /** @type {Map<string, number>} */
  const idByKey = new Map();
  const firstNames = [
    ...new Set(
      patients.filter((p) => kPatientMatchKey(p) != null).map((p) => p.first_name_th),
    ),
  ];
  if (firstNames.length > 0) {
    const { rows } = await pgClient.query(
      `SELECT k.id, k.first_name_th, k.last_name_th, k.mobile_phone, k.phone_home
       FROM public.patient_info k
       WHERE k.first_name_th = ANY($1::text[]) AND ${migrationKPatientSql("k")}
       ORDER BY k.id`,
      [firstNames],
    );
    for (const r of rows) {
      const key = kPatientMatchKey(r);
      if (key != null && !idByKey.has(key)) idByKey.set(key, Number(r.id));
    }
  }

  let reused = 0;
  /** index ใน patients ที่ต้องสร้างใหม่ — นัดหลายนัดคีย์เดียวกันใน chunk ใช้แถวเดียว */
  const toCreate = [];
  /** @type {Map<string, number>} คีย์ → index ใน toCreate */
  const pendingByKey = new Map();
  const pendingIndexOf = new Array(patients.length).fill(-1);
  for (let i = 0; i < patients.length; i++) {
    const key = kPatientMatchKey(patients[i]);
    if (key != null && idByKey.has(key)) {
      ids[i] = idByKey.get(key);
      reused++;
      continue;
    }
    if (key != null && pendingByKey.has(key)) {
      pendingIndexOf[i] = pendingByKey.get(key);
      continue;
    }
    pendingIndexOf[i] = toCreate.length;
    if (key != null) pendingByKey.set(key, toCreate.length);
    toCreate.push(patients[i]);
  }
  if (toCreate.length === 0) return { ids, created: 0, reused };

  // จอง id ก่อน insert → ใส่ pid = 'K' || id ได้ในคำสั่งเดียว (แถวไม่มีช่วงที่ pid ว่าง)
  const { rows: seqRows } = await pgClient.query(
    `SELECT nextval(pg_get_serial_sequence('public.patient_info', 'id'))::int AS id
     FROM generate_series(1, $1::int)`,
    [toCreate.length],
  );
  const newIds = seqRows.map((r) => Number(r.id));
  const withQueueType = await hasCreatedByQueueTypeColumn(pgClient);
  const pick = (f) => toCreate.map((p) => p[f]);
  await pgClient.query(
    `INSERT INTO public.patient_info (
       id, pid, old_db_id, prefix_th, first_name_th, last_name_th, mobile_phone, phone_home,
       ${withQueueType ? "created_by_queue_type, " : ""}date_created
     )
     SELECT t.id, 'K' || t.id, 'K' || t.id, t.prefix_th, t.first_name_th, t.last_name_th,
            t.mobile_phone, t.phone_home, ${withQueueType ? "'K', " : ""}now()
     FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
       AS t(id, prefix_th, first_name_th, last_name_th, mobile_phone, phone_home)`,
    [
      newIds,
      pick("prefix_th"),
      pick("first_name_th"),
      pick("last_name_th"),
      pick("mobile_phone"),
      pick("phone_home"),
    ],
  );
  for (let i = 0; i < patients.length; i++) {
    if (ids[i] == null) ids[i] = newIds[pendingIndexOf[i]];
  }
  return { ids, created: toCreate.length, reused };
}

/**
 * ย้ายนัดที่ยังผูกคนไข้ K (ที่ migration สร้าง) ไปผูกคนไข้จริง
 * @param {import("pg").PoolClient} pgClient
 * @param {string} patientColumn คอลัมน์ patient ของ public.appointment (ตรวจจาก information_schema แล้ว)
 * @param {{ appointmentId: number, patientId: number }[]} pairs นัดไหนควรเป็นคนไข้คนไหน
 *   นัดเดียวชี้หลายคน = กำกวม ไม่ย้าย
 * @returns {Promise<{ relinked: number, kIds: number[] }>} kIds = K เดิมที่อาจไม่มีใครใช้แล้ว (ส่งต่อให้ deleteOrphanMigrationKPatients)
 */
export async function relinkAppointmentsFromMigrationK(pgClient, patientColumn, pairs) {
  /** @type {Map<number, number | null>} */
  const byAppt = new Map();
  for (const { appointmentId, patientId } of pairs) {
    if (appointmentId == null || patientId == null) continue;
    const a = Number(appointmentId);
    const p = Number(patientId);
    if (!byAppt.has(a)) byAppt.set(a, p);
    else if (byAppt.get(a) !== p) byAppt.set(a, null);
  }
  const apptIds = [];
  const patientIds = [];
  for (const [a, p] of byAppt) {
    if (p == null) continue;
    apptIds.push(a);
    patientIds.push(p);
  }
  if (apptIds.length === 0) return { relinked: 0, kIds: [] };

  const col = `"${patientColumn}"`;
  const { rows } = await pgClient.query(
    `WITH v AS (
       SELECT * FROM unnest($1::int[], $2::int[]) AS v(appt_id, patient_id)
     ), c AS (
       SELECT a.id AS appt_id, a.${col} AS k_id, v.patient_id
       FROM v
       JOIN public.appointment a ON a.id = v.appt_id
       JOIN public.patient_info k ON k.id = a.${col}
       WHERE ${migrationKPatientSql("k")} AND v.patient_id <> k.id
     )
     UPDATE public.appointment a
     SET ${col} = c.patient_id
     FROM c
     WHERE a.id = c.appt_id
     RETURNING c.k_id`,
    [apptIds, patientIds],
  );
  return {
    relinked: rows.length,
    kIds: [...new Set(rows.map((r) => Number(r.k_id)))],
  };
}

const INT_TYPES = new Set(["integer", "bigint", "smallint"]);

/**
 * คอลัมน์ที่อ้าง public.patient_info.id: FK จริง + relation ของ Directus (ตารางที่ไม่มี FK)
 * FK ทุกตัวเป็น ON DELETE SET NULL — ลบแถวที่ยังถูกอ้างจะทำให้ข้อมูลหลุดเงียบๆ จึงต้องเช็คก่อนลบ
 * @returns {Promise<{ table: string, column: string, isInt: boolean }[]>}
 */
async function loadPatientInfoReferences(pgClient) {
  const { rows: dr } = await pgClient.query(
    "SELECT to_regclass('public.directus_relations') IS NOT NULL AS ok",
  );
  const { rows } = await pgClient.query(`
    WITH refs AS (
      SELECT c.relname::text AS tbl, a.attname::text AS col
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
      WHERE k.contype = 'f'
        AND k.confrelid = 'public.patient_info'::regclass
        AND array_length(k.conkey, 1) = 1
        AND n.nspname = 'public'
      ${
        dr[0]?.ok === true
          ? `UNION
      SELECT r.many_collection::text, r.many_field::text
      FROM public.directus_relations r
      WHERE r.one_collection = 'patient_info'`
          : ""
      }
    )
    SELECT DISTINCT refs.tbl, refs.col, ic.data_type
    FROM refs
    JOIN information_schema.columns ic
      ON ic.table_schema = 'public' AND ic.table_name = refs.tbl AND ic.column_name = refs.col
    WHERE refs.tbl <> 'patient_info'
  `);
  return rows
    .filter((r) => /^[\w]+$/.test(r.tbl) && /^[\w]+$/.test(r.col))
    .map((r) => ({ table: r.tbl, column: r.col, isInt: INT_TYPES.has(r.data_type) }));
}

/**
 * ลบคนไข้ K ที่ migration สร้าง เมื่อไม่มีตารางไหนอ้างถึงแล้ว และยังไม่ถูกแก้ในระบบใหม่ (user_updated ว่าง)
 * เรียกครั้งเดียวท้าย job — ตารางที่ไม่มี index ที่คอลัมน์ patient จะถูกสแกนตารางละครั้ง
 * @param {import("pg").PoolClient} pgClient
 * @param {Iterable<number>} candidateIds
 * @returns {Promise<number>} จำนวนที่ลบ
 */
export async function deleteOrphanMigrationKPatients(pgClient, candidateIds) {
  const ids = [...new Set([...candidateIds].map(Number))].filter(Number.isFinite);
  if (ids.length === 0) return 0;

  const refs = await loadPatientInfoReferences(pgClient);
  // คอลัมน์ int เทียบตรง (ใช้ index ได้), ชนิดอื่นเทียบเป็นข้อความ
  const used = refs.map((r) =>
    r.isInt
      ? `SELECT "${r.column}"::text AS id FROM public."${r.table}" WHERE "${r.column}" = ANY($1::int[])`
      : `SELECT "${r.column}"::text AS id FROM public."${r.table}" WHERE "${r.column}"::text = ANY($1::int[]::text[])`,
  );
  const r = await pgClient.query(
    `DELETE FROM public.patient_info k
     WHERE k.id = ANY($1::int[])
       AND ${migrationKPatientSql("k")}
       AND k.user_updated IS NULL
       ${used.length > 0 ? `AND k.id::text NOT IN (SELECT id FROM (${used.join(" UNION ")}) u WHERE id IS NOT NULL)` : ""}`,
    [ids],
  );
  return r.rowCount ?? 0;
}
