/**
 * birads_mass_cyst — เติม appointment.us_mass + appointment.assessment_birads_des ให้ appointment ที่ migrate มา
 *
 * เลียน flow Directus "[id-86]<add birad/mass at appointment create>" (= endpoint bis-birads-mass):
 *   examination ของคนไข้ที่มี us.state = '3' (Sign to PACs)
 *   → us_mass = ultrasound ทุกแถวของ exam นั้น (us.*)
 *   → assessment_birads_des = examination_general[0].assessment_birads_des
 * ต่างจาก flow ตรงที่เลือก exam "ล่าสุดก่อนวันนัด" แทน "ล่าสุดของคนไข้" — flow รันตอนสร้างนัด
 * ผลที่มีตอนนั้นคือผลก่อนวันนัด; นัดที่ยังไม่ถึงจึงได้ค่าเท่ากับ flow ส่วนนัดในอดีตไม่ได้ผลของ exam ตัวเอง
 *
 * อ่าน Postgres ล้วน — ultrasound / examination_general / examination migrate เข้ามาแล้วในลำดับก่อนหน้า
 * ultrasound.exam / examination_general.exam ไม่มี index (ไม่สร้างเพิ่มบน prod) จึงอ่านรวดเดียวลง temp table
 * แล้วเก็บ id แถว ultrasound ไว้ดึงผ่าน PK ตอนสร้าง JSON ทีละ batch
 */

export const DROP_TEMP_TABLES = `
DROP TABLE IF EXISTS bmc_pick, bmc_signed_exam
`.trim();

/** exam ที่มี US state '3' อย่างน้อย 1 แถว — 1 แถวต่อ exam */
export const CREATE_SIGNED_EXAM_TABLE = `
CREATE TEMP TABLE bmc_signed_exam AS
WITH us AS (
  SELECT u.exam AS exam_id,
         max(u.exam_date) AS exam_date,
         array_agg(u.id ORDER BY u.id) AS us_ids
  FROM public.ultrasound u
  WHERE u.exam IS NOT NULL
  GROUP BY u.exam
  HAVING bool_or(u.state = '3')
),
gen AS (
  SELECT DISTINCT ON (g.exam) g.exam AS exam_id, g.assessment_birads_des
  FROM public.examination_general g
  WHERE g.exam IN (SELECT exam_id FROM us)
  ORDER BY g.exam, g.id
)
SELECT x.patient,
       us.exam_id,
       x.appointment AS exam_appointment,
       us.exam_date,
       us.us_ids,
       gen.assessment_birads_des
FROM us
JOIN public.examination x ON x.id = us.exam_id
LEFT JOIN gen ON gen.exam_id = us.exam_id
WHERE x.patient IS NOT NULL
`.trim();

export const INDEX_SIGNED_EXAM_TABLE = [
  "ALTER TABLE bmc_signed_exam ADD PRIMARY KEY (exam_id)",
  "CREATE INDEX ON bmc_signed_exam (patient, exam_date DESC, exam_id DESC)",
  "ANALYZE bmc_signed_exam",
];

/** นับ appointment ที่ migrate มา (old_db_id ไม่ว่าง) — แยกแถวที่เลือก exam ไม่ได้ */
export const MIGRATED_APPOINTMENT_COUNTS = `
SELECT count(*)::int AS migrated,
       count(*) FILTER (WHERE a.patient_info IS NULL)::int AS no_patient_info,
       count(*) FILTER (
         WHERE a.patient_info IS NOT NULL AND a.appointment_datetime IS NULL
       )::int AS no_appointment_datetime
FROM public.appointment a
WHERE a.old_db_id IS NOT NULL AND a.old_db_id <> ''
`.trim();

/**
 * exam ที่เลือกต่อ appointment: US state '3' ของคนไข้คนเดียวกัน ตรวจก่อนวันนัด (ไม่นับวันเดียวกัน)
 * และไม่ใช่ exam ของนัดนี้เอง — เอาวันตรวจล่าสุด เสมอกันเอา exam id มากสุด (flow sort -id)
 * appointment ที่สร้างในระบบใหม่ (old_db_id ว่าง) ไม่แตะ — flow เติมให้ตอนสร้างแล้ว
 */
export const CREATE_PICK_TABLE = `
CREATE TEMP TABLE bmc_pick AS
SELECT a.id AS appointment_id, s.exam_id
FROM public.appointment a
CROSS JOIN LATERAL (
  SELECT se.exam_id
  FROM bmc_signed_exam se
  WHERE se.patient = a.patient_info
    AND se.exam_date < date_trunc('day', a.appointment_datetime)
    AND se.exam_appointment IS DISTINCT FROM a.id
  ORDER BY se.exam_date DESC, se.exam_id DESC
  LIMIT 1
) s
WHERE a.old_db_id IS NOT NULL AND a.old_db_id <> ''
  AND a.patient_info IS NOT NULL
  AND a.appointment_datetime IS NOT NULL
`.trim();

export const INDEX_PICK_TABLE = [
  "ALTER TABLE bmc_pick ADD PRIMARY KEY (appointment_id)",
  "ANALYZE bmc_pick",
];

export const COUNT_TEMP_TABLES = `
SELECT (SELECT count(*) FROM bmc_signed_exam)::int AS signed_exams,
       (SELECT count(*) FROM bmc_pick)::int AS picked
`.trim();

/**
 * batch ถัดจาก $1 (appointment id) จำนวน $2 แถว — สร้าง JSON ใหม่แล้ว UPDATE เฉพาะแถวที่ค่าเปลี่ยน
 * us_mass = row_to_json ของ ultrasound ทั้งแถว (เท่ากับ us.* ของ Directus) เรียงตาม id
 * payload ต้อง MATERIALIZED — ถ้า inline ตัว json_agg ถูกคำนวณ 2 รอบต่อแถว (WHERE เทียบค่า + SET)
 */
export const UPDATE_BATCH = `
WITH b AS (
  SELECT p.appointment_id, p.exam_id
  FROM bmc_pick p
  WHERE p.appointment_id > $1::bigint
  ORDER BY p.appointment_id
  LIMIT $2
),
payload AS MATERIALIZED (
  SELECT se.exam_id,
         se.assessment_birads_des,
         (SELECT json_agg(row_to_json(u) ORDER BY u.id)
            FROM public.ultrasound u
           WHERE u.id = ANY (se.us_ids)) AS us_mass
  FROM (SELECT DISTINCT exam_id FROM b) bx
  JOIN bmc_signed_exam se ON se.exam_id = bx.exam_id
),
upd AS (
  UPDATE public.appointment a
  SET us_mass = pl.us_mass,
      assessment_birads_des = pl.assessment_birads_des
  FROM b
  JOIN payload pl ON pl.exam_id = b.exam_id
  WHERE a.id = b.appointment_id
    AND (a.us_mass::text IS DISTINCT FROM pl.us_mass::text
      OR a.assessment_birads_des IS DISTINCT FROM pl.assessment_birads_des)
  RETURNING a.id
)
SELECT (SELECT count(*) FROM b)::int AS batch_rows,
       (SELECT max(appointment_id) FROM b)::text AS last_id,
       (SELECT count(*) FROM upd)::int AS rows_updated
`.trim();
