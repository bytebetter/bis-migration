const CREATE_PROCEDURE_STAGING_TABLE = `
CREATE TABLE migrate_stg.biopsy_mssql (
  exam_id TEXT,
  biopsy_id TEXT,
  exam_date TEXT,
  pid TEXT,
  radiologist TEXT,
  clinical TEXT,
  finding TEXT,
  location TEXT,
  biopsy_proc TEXT,
  biopsy_proc_des TEXT,
  needle_no TEXT,
  technique TEXT,
  technique_des TEXT,
  patient_pos TEXT,
  patient_pos_des TEXT,
  breast_compress TEXT,
  breast_compress_des TEXT,
  approach TEXT,
  approach_des TEXT,
  spontaneous_discharge TEXT,
  result_aspiration_cc TEXT,
  result_aspiration_app TEXT,
  result_aspiration_app_des TEXT,
  result_aspiration_cytology TEXT,
  result_aspiration_culture TEXT,
  result_corebiopsy_specimens TEXT,
  result_corebiopsy_microcal TEXT,
  result_needle_within_lesion TEXT,
  result_needle_mm_depth TEXT,
  result_needle_mm_near TEXT,
  result_needle_other TEXT,
  result_ductography TEXT,
  result_ductography_des TEXT,
  result_ductography_other TEXT,
  result_smear_noofslide TEXT,
  result_smear_app TEXT,
  result_smear_app_des TEXT,
  assessment_birads TEXT,
  assessment_birads_des TEXT,
  assessment_others TEXT,
  assessment_others_des TEXT,
  recommend TEXT,
  recommend_des TEXT,
  recommend_benign TEXT,
  recommend_benign_des TEXT,
  recommend_highrisk TEXT,
  recommend_highrisk_des TEXT,
  recommend_malignant TEXT,
  recommend_malignant_des TEXT,
  summary_doctor TEXT,
  summary_doctor_name TEXT,
  special_case TEXT,
  special_case_point_des TEXT,
  special_case_point TEXT,
  special_case_detail TEXT,
  patho_code TEXT,
  patho_code_full_des TEXT,
  patho_code_fill_by TEXT,
  patho_code_result_date TEXT,
  is_final TEXT,
  patient_type TEXT,
  patient_type_des TEXT,
  remark TEXT,
  remark_other TEXT,
  remark_text TEXT,
  width TEXT,
  depth TEXT,
  corrected TEXT,
  corrected_date TEXT,
  location_left_other TEXT,
  location_right_other TEXT,
  last_exam_id TEXT
);
`.trim();

export async function ensureProcedureStagingDdl(pgClient) {
  await pgClient.query("CREATE SCHEMA IF NOT EXISTS migrate_stg;");
  await pgClient.query("DROP TABLE IF EXISTS migrate_stg.biopsy_mssql;");
  await pgClient.query(CREATE_PROCEDURE_STAGING_TABLE);
  await pgClient.query(
    "COMMENT ON TABLE migrate_stg.biopsy_mssql IS 'Staging: dbo.biopsy จาก MSSQL ก่อนแปลงเข้า public.procedure';",
  );
}

/**
 * ปลายทาง Directus มักยังไม่มีคอลัมน์ trace จาก MSSQL — เพิ่ม old_db_id ({Exam_ID}_{BiopsyID}) ถ้ายังไม่มี
 */
export async function ensureProcedureOldDbIdColumn(pgClient) {
  console.error(
    ">>> [procedure] ensure: public.\"procedure\".old_db_id (ถ้ายังไม่มีจะ ADD COLUMN)",
  );
  await pgClient.query(`
    DO $proc_old_db$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'procedure'
          AND c.relkind = 'r'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'procedure'
          AND column_name = 'old_db_id'
      ) THEN
        ALTER TABLE public."procedure" ADD COLUMN old_db_id varchar(320);
      END IF;
    END
    $proc_old_db$;
  `);
  await pgClient.query(`
    CREATE INDEX IF NOT EXISTS idx_procedure_old_db_id
    ON public."procedure" (old_db_id)
    WHERE old_db_id IS NOT NULL;
  `);
  console.error(">>> [procedure] ensure: old_db_id + index (ถ้ามีแล้วจะข้าม)");
}

export async function ensureProcedurePipelineDdl(pgClient) {
  await ensureProcedureStagingDdl(pgClient);
  await ensureProcedureOldDbIdColumn(pgClient);
}
