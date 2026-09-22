const NORM_EXAM_ID_FN = `
CREATE OR REPLACE FUNCTION migrate_stg.norm_exam_id(t text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT btrim(regexp_replace(coalesce($1, ''), '^' || chr(65279), ''))
$$;
`.trim();

const NORM_PID_FN = `
CREATE OR REPLACE FUNCTION migrate_stg.norm_pid(t text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT btrim(regexp_replace(coalesce($1, ''), '^' || chr(65279), ''))
$$;
`.trim();

const CREATE_EXAMINATION_STAGING_TABLE = `
CREATE TABLE migrate_stg.examination_mssql (
  exam_id TEXT NOT NULL PRIMARY KEY,
  exam_date TEXT,
  pid TEXT,
  tech_login_name TEXT,
  mobile TEXT,
  mobile_update TEXT,
  menstruation_age TEXT,
  menopause_age TEXT,
  first_pregnancy_age TEXT,
  num_pregnancy TEXT,
  cont_use TEXT,
  cont_yrs TEXT,
  hormone_use TEXT,
  hormone_yrs TEXT,
  hysterectomy TEXT,
  ovaries_removed TEXT,
  pragnant TEXT,
  referring_md TEXT,
  referring_hospital TEXT,
  prev_mammo_date TEXT,
  prev_mammo_loc TEXT,
  sister_cancer_age TEXT,
  mother_cancer_age TEXT,
  grandmother_cancer_age TEXT,
  other_cancer_age TEXT,
  biopsy_l_date TEXT,
  biopsy_r_date TEXT,
  chemo_l_date TEXT,
  chemo_r_date TEXT,
  cyst_l_date TEXT,
  cyst_r_date TEXT,
  irr_l_date TEXT,
  irr_r_date TEXT,
  lump_l_date TEXT,
  lump_r_date TEXT,
  mast_l_date TEXT,
  mast_r_date TEXT,
  rad_l_date TEXT,
  rad_r_date TEXT,
  num_left_mass TEXT,
  num_right_mass TEXT,
  lnwn TEXT,
  lnww TEXT,
  ln TEXT,
  lnen TEXT,
  lnee TEXT,
  le TEXT,
  lm TEXT,
  lw TEXT,
  lsws TEXT,
  lsww TEXT,
  ls TEXT,
  lses TEXT,
  lsee TEXT,
  rnwn TEXT,
  rnww TEXT,
  rn TEXT,
  rnen TEXT,
  rnee TEXT,
  re TEXT,
  rm TEXT,
  rw TEXT,
  rsws TEXT,
  rsww TEXT,
  rs TEXT,
  rses TEXT,
  rsee TEXT,
  lother TEXT,
  rother TEXT,
  l_axillar TEXT,
  r_axillar TEXT,
  exam_reason TEXT,
  exam_reason_text TEXT,
  exam_reason_memotext TEXT,
  pain_l_duration TEXT,
  pain_r_duration TEXT,
  mobile_updated TEXT,
  mobile_loc TEXT,
  bct_r_date TEXT,
  bct_l_date TEXT,
  patient_cancer_age TEXT,
  daughter_cancer_age TEXT,
  daughter_cancer_age_more TEXT,
  sister_cancer_age_more TEXT,
  other_cancer_age_more TEXT,
  stophormone_yrs TEXT,
  ca_hormone_use TEXT,
  ca_hormone_yrs TEXT,
  stop_ca_hormone_yrs TEXT,
  stop_contr_yrs TEXT,
  rm_l_date TEXT,
  rm_r_date TEXT,
  ri_l_date TEXT,
  ri_r_date TEXT,
  fna_l_date TEXT,
  fna_r_date TEXT,
  fnx_l_date TEXT,
  fnx_r_date TEXT,
  send_exam_login_name TEXT,
  schedule_id TEXT
);
`.trim();

export async function ensureExaminationStagingDdl(pgClient) {
  console.error(">>> [examination] ensure: create schema migrate_stg");
  await pgClient.query("CREATE SCHEMA IF NOT EXISTS migrate_stg;");
  console.error(">>> [examination] ensure: create function migrate_stg.norm_exam_id");
  await pgClient.query(NORM_EXAM_ID_FN);
  console.error(">>> [examination] ensure: create function migrate_stg.norm_pid");
  await pgClient.query(NORM_PID_FN);
  console.error(">>> [examination] ensure: drop old staging table (if exists)");
  await pgClient.query("DROP TABLE IF EXISTS migrate_stg.examination_mssql;");
  console.error(">>> [examination] ensure: create staging table migrate_stg.examination_mssql");
  await pgClient.query(CREATE_EXAMINATION_STAGING_TABLE);
  console.error(">>> [examination] ensure: comment staging table");
  await pgClient.query(
    "COMMENT ON TABLE migrate_stg.examination_mssql IS 'Staging: examination จาก MSSQL ก่อนแปลงเข้า public.examination';"
  );
  console.error(">>> [examination] ensure: staging DDL done");
}

/**
 * ฟิลด์ relation public.examination.mobile_location -> public.mobile_location(id)
 *
 * ต้นทางมีแค่ [Mobile_Loc] เป็นเลข id ของระบบเก่า (เก็บดิบไว้ที่คอลัมน์ mobile_loc เหมือนเดิม)
 * ฟิลด์นี้คือตัวที่ join กับตาราง mobile_location จริง — สร้างเองทุกครั้ง (idempotent)
 * เพราะของที่ไม่ได้สร้างผ่าน Directus UI จะไม่ติดมากับ dump ตอน restore baseline
 *
 * metadata ของ Directus (directus_fields/directus_relations) ใส่ให้ด้วย เพื่อให้ขึ้นเป็น m2o ใน UI
 * — Directus cache schema ไว้ ต้อง restart หรือล้าง cache 1 ครั้งหลังสร้างครั้งแรก
 */
export async function ensureExaminationMobileLocationField(pgClient) {
  console.error(">>> [examination] ensure: column examination.mobile_location");
  await pgClient.query(`
    ALTER TABLE public.examination
      ADD COLUMN IF NOT EXISTS mobile_location integer;
  `);

  // FK ตั้งได้เมื่อมีตาราง mobile_location แล้ว (migrate step 0 มาก่อน examination)
  await pgClient.query(`
DO $$
BEGIN
  IF to_regclass('public.mobile_location') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'examination_mobile_location_foreign'
     ) THEN
    ALTER TABLE public.examination
      ADD CONSTRAINT examination_mobile_location_foreign
      FOREIGN KEY (mobile_location) REFERENCES public.mobile_location(id)
      ON DELETE SET NULL;
  END IF;
END $$;
`.trim());

  await pgClient.query(`
DO $$
BEGIN
  IF to_regclass('public.directus_fields') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.directus_fields
       WHERE collection = 'examination' AND field = 'mobile_location'
     ) THEN
    INSERT INTO public.directus_fields
      (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width)
    VALUES
      ('examination', 'mobile_location', 'm2o', 'select-dropdown-m2o',
       '{"template":"{{name}}"}', 'related-values', '{"template":"{{name}}"}',
       false, false,
       (SELECT COALESCE(MAX(sort), 0) + 1 FROM public.directus_fields WHERE collection = 'examination'),
       'half');
  END IF;

  IF to_regclass('public.directus_relations') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.directus_relations
       WHERE many_collection = 'examination' AND many_field = 'mobile_location'
     ) THEN
    INSERT INTO public.directus_relations
      (many_collection, many_field, one_collection, one_deselect_action)
    VALUES ('examination', 'mobile_location', 'mobile_location', 'nullify');
  END IF;
END $$;
`.trim());
  console.error(
    ">>> [examination] ensure: mobile_location column + FK + Directus field/relation (ถ้ามีแล้วจะข้าม)",
  );
}

/** ลด O(n) ตอน public.examination โต: DELETE/ JOIN stats ตาม old_exam_id */
export async function ensureExaminationOldExamIdIndex(pgClient) {
  console.error(">>> [examination] ensure: create index idx_examination_old_exam_id");
  await pgClient.query(`
    CREATE INDEX IF NOT EXISTS idx_examination_old_exam_id
    ON public.examination (old_exam_id);
  `);
  console.error(">>> [examination] ensure: index check done");
}
