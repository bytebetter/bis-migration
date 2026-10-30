/**
 * history_report — สร้างประวัติรายงานให้ exam ที่ต้นทาง Sign to PACs report ของ mammogram / ultrasound แล้ว
 * แต่ยังไม่มีแถวใน history_report ผูกกับ examination_general แถวแรกของ exam (ตัวเดียวกับที่หน้าเว็บ sign)
 *
 * ตัดสินจาก dbo.PACS_EXPORT_PDF ทุกรอบ ไม่ใช่ state ใน Postgres: resume เป็น insert-only
 * เคสที่เข้ามาตอนยัง Report แล้วไป sign ทีหลัง state จะค้าง '1' ตลอด
 * เคสที่สร้างในระบบใหม่ไม่อยู่ในต้นทาง จึงไม่ถูกแตะ (ตอน sign หน้าเว็บเขียน history_report เอง)
 *
 * เนื้อรายงานอ่านจาก Postgres — ตารางลูกทั้งหมด migrate เข้ามาแล้วในลำดับก่อนหน้า
 * คอลัมน์ exam ของตารางลูกไม่มี index (ไม่สร้างเพิ่มบน prod) จึงอ่านรวดเดียวลง temp table
 * แล้วเก็บ id ไว้ดึงผ่าน PK ทีละ batch แบบเดียวกับ birads_mass_cyst
 *
 * procedure ไม่นับเป็นเงื่อนไข: หน้าเว็บ sign procedure แล้วไม่เขียน history_report และ PDF ฉบับนี้
 * มีแค่ mam/us — แถวของ procedure ยังอยู่ใน formData.procedure ของ exam ตามปกติ
 */

/**
 * relation ของ formData — key = ชื่อ field ใน examination
 * ตารางที่ไม่ได้ migrate จาก MSSQL (ultrasound_non_mass, spot ...) อาจไม่มีในบาง DB: เตือนแล้วให้เป็น []
 */
export const CHILD_SPECS = [
  { key: "us", table: "ultrasound", fk: "exam" },
  { key: "examination_general", table: "examination_general", fk: "exam" },
  { key: "mam", table: "mammogram", fk: "exam" },
  { key: "mammogram_cal", table: "mammogram_cal", fk: "exam" },
  { key: "mammogram_mass", table: "mammogram_mass", fk: "exam" },
  { key: "ultrasound_mass", table: "ultrasound_mass", fk: "exam" },
  { key: "ultrasound_cyst", table: "ultrasound_cyst", fk: "exam" },
  { key: "ultrasound_non_mass", table: "ultrasound_non_mass", fk: "exam" },
  { key: "procedure", table: "procedure", fk: "exam" },
  {
    key: "pacs_sync_infos",
    table: "pacs_sync_info",
    fk: "exam",
    columns: ["id", "exam", "modality", "end_time", "is_mark_del", "accession_id"],
  },
  { key: "spots", table: "spot", fk: "exam" },
  { key: "spot_shapes", table: "spot_shape", fk: "spot", parent: "spots" },
  { key: "exam_reason_multi", table: "examination_exam_reason", fk: "examination_id" },
  {
    key: "spot_technicians",
    table: "examination_directus_users_2",
    fk: "examination_id",
    columns: ["id", "examination_id"],
  },
];

export const DROP_TEMP_TABLES = `
DROP TABLE IF EXISTS hr_history, hr_child, hr_target, hr_exam, hr_source_signed
`.trim();

export const CREATE_SOURCE_SIGNED_TABLE = `
CREATE TEMP TABLE hr_source_signed (old_exam_id text PRIMARY KEY)
`.trim();

/** $1 = Exam_ID ต้นทาง */
export const INSERT_SOURCE_SIGNED = `
INSERT INTO hr_source_signed (old_exam_id)
SELECT unnest($1::text[])
`.trim();

export const INDEX_SOURCE_SIGNED_TABLE = ["ANALYZE hr_source_signed"];

/**
 * 1 แถวต่อ exam ที่ต้นทาง sign แล้วและมีใน Postgres — has_history นับทุก examination_general ของ exam
 * has_report = มี mam/us ที่ render ได้ (state 1/3 ตาม isSignableModality) ไม่มีต้องรอรอบถัดไป
 * ไม่งั้นได้ snapshot ที่ไม่มีเนื้อรายงานค้างถาวร เพราะ exam ที่มีแถวแล้วจะถูกข้าม
 */
export const CREATE_EXAM_TABLE = `
CREATE TEMP TABLE hr_exam AS
WITH report AS (
  SELECT m.exam AS exam_id FROM public.mammogram m WHERE m.state IN ('1', '3') AND m.exam IS NOT NULL
  UNION
  SELECT u.exam FROM public.ultrasound u WHERE u.state IN ('1', '3') AND u.exam IS NOT NULL
)
SELECT x.id AS exam_id,
       x.patient,
       bool_or(r.exam_id IS NOT NULL) AS has_report,
       min(g.id) AS general_id,
       bool_or(h.examination_general IS NOT NULL) AS has_history
FROM hr_source_signed s
JOIN public.examination x ON x.old_exam_id::text = s.old_exam_id
LEFT JOIN report r ON r.exam_id = x.id
LEFT JOIN public.examination_general g ON g.exam = x.id
LEFT JOIN (SELECT DISTINCT hr.examination_general FROM public.history_report hr) h
  ON h.examination_general = g.id
GROUP BY x.id, x.patient
`.trim();

export const COUNT_EXAM_TABLE = `
SELECT (SELECT count(*) FROM hr_source_signed)::int AS source_signed,
       count(*)::int AS in_postgres,
       count(*) FILTER (WHERE NOT has_report)::int AS no_report,
       count(*) FILTER (WHERE general_id IS NULL)::int AS no_general,
       count(*) FILTER (WHERE has_history)::int AS has_history
FROM hr_exam
`.trim();

/** $1 = จำนวนสูงสุด (null = ทั้งหมด) — รันทดลองเอา exam ล่าสุดก่อน เปิดดูในระบบใหม่ได้ง่าย */
export const CREATE_TARGET_TABLE = `
CREATE TEMP TABLE hr_target AS
SELECT exam_id, general_id, patient
FROM hr_exam
WHERE has_report AND general_id IS NOT NULL AND NOT has_history
ORDER BY exam_id DESC
LIMIT $1::bigint
`.trim();

export const INDEX_TARGET_TABLE = [
  "ALTER TABLE hr_target ADD PRIMARY KEY (exam_id)",
  "ANALYZE hr_target",
];

export const CREATE_CHILD_TABLE = `
CREATE TEMP TABLE hr_child (
  key text NOT NULL,
  parent_id bigint NOT NULL,
  ids bigint[] NOT NULL
)
`.trim();

export const INDEX_CHILD_TABLE = [
  "CREATE INDEX ON hr_child (key, parent_id)",
  "ANALYZE hr_child",
];

/** ชื่อใน spec เป็นค่าคงที่ในไฟล์นี้ ไม่ได้มาจาก input */
export function fillChildSql(spec) {
  const parents = spec.parent
    ? `SELECT unnest(ids) AS id FROM hr_child WHERE key = '${spec.parent}'`
    : "SELECT exam_id AS id FROM hr_target";
  return `
INSERT INTO hr_child (key, parent_id, ids)
SELECT '${spec.key}', c."${spec.fk}", array_agg(c.id ORDER BY c.id)
FROM public."${spec.table}" c
JOIN (${parents}) p ON p.id = c."${spec.fk}"
GROUP BY c."${spec.fk}"
`.trim();
}

/** $1 = key ของ spec, $2 = parent id ของ batch */
export function fetchChildSql(spec) {
  const cols = spec.columns
    ? spec.columns.map((c) => `c."${c}"`).join(", ")
    : "c.*";
  return `
SELECT ${cols}
FROM public."${spec.table}" c
WHERE c.id IN (
  SELECT unnest(x.ids) FROM hr_child x WHERE x.key = $1 AND x.parent_id = ANY ($2::bigint[])
)
ORDER BY c.id
`.trim();
}

/** exam ทุกตัวของคนไข้ที่จะสร้างประวัติ — exam_date ว่างหน้าเว็บกรองทิ้งอยู่แล้ว */
export function createHistorySql(fields) {
  const cols = fields.map((f) => `e."${f}"`).join(", ");
  return `
CREATE TEMP TABLE hr_history AS
SELECT e.patient, ${cols}
FROM public.examination e
WHERE e.exam_date IS NOT NULL
  AND e.patient IN (SELECT t.patient FROM hr_target t WHERE t.patient IS NOT NULL)
`.trim();
}

export const INDEX_HISTORY_TABLE = [
  "CREATE INDEX ON hr_history (patient, exam_date DESC, id DESC)",
  "ANALYZE hr_history",
];

export const SELECT_HISTORY_BATCH = `
SELECT *
FROM hr_history
WHERE patient = ANY ($1::bigint[])
ORDER BY patient, exam_date DESC, id DESC
`.trim();

export const SELECT_TARGET_BATCH = `
SELECT exam_id, general_id
FROM hr_target
WHERE exam_id > $1::bigint
ORDER BY exam_id
LIMIT $2
`.trim();

export const SELECT_EXAMS = `
SELECT * FROM public.examination WHERE id = ANY ($1::bigint[])
`.trim();

export const SELECT_COLUMNS = `
SELECT table_name, column_name, udt_name
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = ANY ($1::text[])
`.trim();

/** คอลัมน์ text ที่ Directus แปลงเป็น JSON ตอนอ่าน — prod มี field ที่ baseline ไม่มี จึงอ่านตอนรัน */
export const SELECT_CAST_JSON_FIELDS = `
SELECT collection, field
FROM public.directus_fields
WHERE collection = ANY ($1::text[]) AND special LIKE '%cast-json%'
`.trim();

/** ไม่แตะแถวเดิม — เว้น user_created ไว้ แถวที่หมอ sign จริงมีค่านี้เสมอ จึงแยกแถวจาก job นี้ได้ */
export function insertBatchSql(columns) {
  const isJson = (udt) => udt === "json" || udt === "jsonb";
  const previousDataType = columns.get("previous_data");
  const jsonVersionType = columns.get("json_version");
  const previousData = isJson(previousDataType)
    ? `b.previous_data::${previousDataType}`
    : "b.previous_data";
  // หน้าเว็บส่ง json_version: "" ทุกแถว
  const jsonVersion = isJson(jsonVersionType) ? `'""'::${jsonVersionType}` : "''";
  return `
INSERT INTO public.history_report (examination_general, previous_data, json_version, date_created)
SELECT b.general_id, ${previousData}, ${jsonVersion}, b.date_created
FROM unnest($1::bigint[], $2::text[], $3::timestamptz[]) AS b(general_id, previous_data, date_created)
`.trim();
}
