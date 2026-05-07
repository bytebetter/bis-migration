export async function ensureExaminationGeneralPipelineDdl(pgClient) {
  const CREATE_EXAMINATION_GENERAL_STAGING_TABLE = `
CREATE TABLE migrate_stg.examination_general_mssql (
  exam_id TEXT NOT NULL PRIMARY KEY,
  exam_date TEXT,
  pid TEXT,
  patientexamtype TEXT,
  patientexamtype_des TEXT,
  screening TEXT,
  screening_des TEXT,
  followup TEXT,
  followup_des TEXT,
  r_problemindicated TEXT,
  r_problemindicated_des TEXT,
  l_problemindicated TEXT,
  l_problemindicated_des TEXT,
  pe TEXT,
  pe_des TEXT,
  r_palpable TEXT,
  r_palpable_des TEXT,
  l_palpable TEXT,
  l_palpable_des TEXT,
  assessment_birads TEXT,
  assessment_birads_des TEXT,
  recommendation TEXT,
  recommendation_des_text TEXT,
  recommendation_followupmounths TEXT,
  r_recommendation_coned_compression TEXT,
  l_recommendation_coned_compression TEXT,
  r_recommendation_spot_mag TEXT,
  l_recommendation_spot_mag TEXT,
  r_recommendation_mag TEXT,
  l_recommendation_mag TEXT,
  r_recommendation_coned_compression_des TEXT,
  l_recommendation_coned_compression_des TEXT,
  r_recommendation_spot_mag_des TEXT,
  l_recommendation_spot_mag_des TEXT,
  r_recommendation_mag_des TEXT,
  l_recommendation_mag_des TEXT,
  impression TEXT,
  impression_des TEXT,
  impression_lastexaminationdates TEXT,
  radiologist TEXT,
  specialcase TEXT,
  specialcase_point TEXT,
  specialcase_point_des TEXT,
  specialcase_detail TEXT,
  recommendation_followup_with TEXT,
  isconvertfromoldsystem TEXT,
  sub_birads TEXT,
  followupsymptom TEXT,
  followupmonths TEXT,
  followupletterprintdate TEXT,
  followup_date TEXT,
  corrected TEXT,
  correcteddate TEXT,
  r_followup TEXT,
  r_followup_des TEXT,
  l_followup TEXT,
  l_followup_des TEXT,
  cosign TEXT
);
`.trim();

  await pgClient.query("CREATE SCHEMA IF NOT EXISTS migrate_stg;");
  await pgClient.query("DROP TABLE IF EXISTS migrate_stg.examination_general_mssql;");
  await pgClient.query(CREATE_EXAMINATION_GENERAL_STAGING_TABLE);
  await pgClient.query(
    "COMMENT ON TABLE migrate_stg.examination_general_mssql IS 'Staging: examination_general จาก MSSQL ก่อน map เข้า public.examination_general';",
  );

  // Speed up per-chunk delete/join when target table is large.
  await pgClient.query(`
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'examination_general'
      AND column_name = 'old_exam_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_examination_general_old_exam_id
      ON public.examination_general (old_exam_id);
  END IF;
END $$;
`.trim());
}

