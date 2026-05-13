export async function ensureUltrasoundPipelineDdl(pgClient) {
  const CREATE_ULTRASOUND_STAGING_TABLE = `
CREATE TABLE migrate_stg.ultrasound_mssql (
  exam_id TEXT NOT NULL PRIMARY KEY,
  exam_date TEXT,
  pid TEXT,
  mass TEXT,
  mass_des TEXT,
  num_of_mass_found TEXT,
  num_of_mass_actualfound TEXT,
  cyst TEXT,
  cyst_des TEXT,
  num_of_cyst_found TEXT,
  num_of_cyst_actualfound TEXT,
  tissuecomposition TEXT,
  tissuecomposition_des TEXT,
  r_associatedfeatures TEXT,
  r_associatedfeatures_des TEXT,
  l_associatedfeatures TEXT,
  l_associatedfeatures_des TEXT,
  r_specialcase TEXT,
  r_specialcase_des TEXT,
  l_specialcase TEXT,
  l_specialcase_des TEXT,
  technique TEXT,
  technique_des TEXT
);
`.trim();

  await pgClient.query("CREATE SCHEMA IF NOT EXISTS migrate_stg;");
  await pgClient.query("DROP TABLE IF EXISTS migrate_stg.ultrasound_mssql;");
  await pgClient.query(CREATE_ULTRASOUND_STAGING_TABLE);
  await pgClient.query(
    "COMMENT ON TABLE migrate_stg.ultrasound_mssql IS 'Staging: ultrasound จาก MSSQL ก่อน map เข้า public.ultrasound';",
  );

  await pgClient.query(`
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ultrasound'
      AND column_name = 'old_exam_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_ultrasound_old_exam_id
      ON public.ultrasound (old_exam_id);
  END IF;
END $$;
`.trim());
}
