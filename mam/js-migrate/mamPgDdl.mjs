export async function ensureMamPipelineDdl(pgClient) {
  const CREATE_MAM_STAGING_TABLE = `
CREATE TABLE migrate_stg.mam_mssql (
  exam_id TEXT NOT NULL PRIMARY KEY,
  exam_date TEXT,
  pid TEXT,
  breastcomposition TEXT,
  breastcomposition_des TEXT,
  implant TEXT,
  implant_des TEXT,
  implant_finding TEXT,
  implant_finding_des TEXT,
  technique TEXT,
  r_technique TEXT,
  l_technique TEXT,
  technique_des TEXT,
  mass TEXT,
  mass_des TEXT,
  num_of_mass_actualfound TEXT,
  cal TEXT,
  cal_des TEXT,
  num_of_cal_actualfound TEXT,
  r_addproc_mag TEXT,
  l_addproc_mag TEXT,
  r_addproc_spot_mag TEXT,
  l_addproc_spot_mag TEXT,
  r_addproc_coned_compression TEXT,
  l_addproc_coned_compression TEXT,
  r_addproc_coned_exag_cc TEXT,
  l_addproc_coned_exag_cc TEXT,
  r_addproc_other TEXT,
  l_addproc_other TEXT,
  r_addproc_other_des TEXT,
  l_addproc_other_des TEXT,
  r_specialcase TEXT,
  r_specialcase_des TEXT,
  l_specialcase TEXT,
  l_specialcase_des TEXT,
  r_assfinding TEXT,
  r_assfinding_des TEXT,
  l_assfinding TEXT,
  l_assfinding_des TEXT,
  isconvertfromoldsystem TEXT,
  l_implant TEXT,
  l_implant_des TEXT,
  l_implant_finding TEXT,
  l_implant_finding_des TEXT
);
`.trim();

  await pgClient.query("CREATE SCHEMA IF NOT EXISTS migrate_stg;");
  await pgClient.query("DROP TABLE IF EXISTS migrate_stg.mam_mssql;");
  await pgClient.query(CREATE_MAM_STAGING_TABLE);
  await pgClient.query(
    "COMMENT ON TABLE migrate_stg.mam_mssql IS 'Staging: mammogram จาก MSSQL ก่อน map เข้า public.mammogram';",
  );

  await pgClient.query(`
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'mam'
      AND column_name = 'old_exam_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_mam_old_exam_id
      ON public.mammogram (old_exam_id);
  END IF;
END $$;
`.trim());
}
