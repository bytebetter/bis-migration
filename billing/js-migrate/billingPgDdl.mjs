export async function ensureBillingPipelineDdl(pgClient) {
  const CREATE_BILLING_STAGING_TABLE = `
CREATE TABLE migrate_stg.billing_mssql (
  exam_id TEXT NOT NULL PRIMARY KEY,
  exam_date TEXT,
  pid TEXT,
  is_in_patient TEXT,
  can_claim_expense TEXT,
  hnno TEXT,
  an TEXT,
  room TEXT,
  building TEXT,
  codeno TEXT,
  note TEXT,
  patient_type TEXT,
  total TEXT,
  receipt TEXT,
  receipt_no TEXT,
  a TEXT,
  a_price TEXT,
  b TEXT,
  b_price TEXT,
  c TEXT,
  c_price TEXT,
  d TEXT,
  d_price TEXT,
  e TEXT,
  e_price TEXT,
  f TEXT,
  f_price TEXT,
  g TEXT,
  g_price TEXT,
  h TEXT,
  h_price TEXT,
  i TEXT,
  i_price TEXT,
  j TEXT,
  j_price TEXT,
  k TEXT,
  k_price TEXT,
  l TEXT,
  l_price TEXT,
  m TEXT,
  m_price TEXT,
  n TEXT,
  n_price TEXT,
  o TEXT,
  o_price TEXT,
  p TEXT,
  p_price TEXT,
  q TEXT,
  q_price TEXT,
  r TEXT,
  r_price TEXT,
  s TEXT,
  s_price TEXT,
  t TEXT,
  t_price TEXT,
  u TEXT,
  u_price TEXT,
  mammogram_tec1 TEXT,
  mammogram_tec2 TEXT,
  ultrasound_tec1 TEXT,
  ultrasound_tec2 TEXT,
  ultrasound_tec3 TEXT,
  ultrasound_tec4 TEXT,
  ultrasound_tec5 TEXT,
  ultrasound_tec6 TEXT,
  stereo_biop_position TEXT,
  us_guided_bx_position TEXT,
  aspiration_position TEXT,
  ductogram_film TEXT,
  copy_film_film TEXT,
  cash TEXT,
  schedule_date TEXT,
  opd TEXT,
  opd_price TEXT,
  foreigner TEXT
);
`.trim();

  const CREATE_BILLING_EXAM_MAP = `
CREATE TABLE migrate_stg.billing_exam_map (
  old_exam_id TEXT NOT NULL PRIMARY KEY,
  exam_id INTEGER,
  appointment BIGINT
);
`.trim();

  await pgClient.query("CREATE SCHEMA IF NOT EXISTS migrate_stg;");
  await pgClient.query("DROP TABLE IF EXISTS migrate_stg.billing_mssql;");
  await pgClient.query("DROP TABLE IF EXISTS migrate_stg.billing_exam_map;");
  await pgClient.query(CREATE_BILLING_STAGING_TABLE);
  await pgClient.query(CREATE_BILLING_EXAM_MAP);
  await pgClient.query(
    "COMMENT ON TABLE migrate_stg.billing_mssql IS 'Staging: billing จาก MSSQL ก่อน map เข้า public.billing';",
  );

  await pgClient.query(`
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'billing'
      AND column_name = 'old_exam_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_billing_old_exam_id
      ON public.billing (old_exam_id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'examination'
      AND column_name = 'old_exam_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_examination_old_exam_id
      ON public.examination (old_exam_id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'patient_info'
      AND column_name = 'pid'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_patient_info_pid
      ON public.patient_info (pid);
  END IF;
END $$;
`.trim());
}
