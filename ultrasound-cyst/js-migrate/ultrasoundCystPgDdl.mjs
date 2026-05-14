export async function ensureUltrasoundCystPipelineDdl(pgClient) {
  const CREATE_ULTRASOUND_CYST_STAGING_TABLE = `
CREATE TABLE migrate_stg.ultrasound_cyst_mssql (
  described_cyst_id TEXT NOT NULL,
  exam_id TEXT NOT NULL,
  exam_date TEXT,
  pid TEXT,
  echo_pattern TEXT,
  echo_pattern_des TEXT,
  shape TEXT,
  shape_des TEXT,
  size_width TEXT,
  size_depth TEXT,
  wall_margin TEXT,
  wall_margin_des TEXT,
  solid_component TEXT,
  r_position TEXT,
  r_position_des TEXT,
  l_position TEXT,
  l_position_des TEXT,
  l_position_clock TEXT,
  r_position_clock TEXT,
  PRIMARY KEY (exam_id, described_cyst_id)
);
`.trim();

  await pgClient.query("CREATE SCHEMA IF NOT EXISTS migrate_stg;");
  await pgClient.query("DROP TABLE IF EXISTS migrate_stg.ultrasound_cyst_mssql;");
  await pgClient.query(CREATE_ULTRASOUND_CYST_STAGING_TABLE);
  await pgClient.query(
    "COMMENT ON TABLE migrate_stg.ultrasound_cyst_mssql IS 'Staging: ultrasound_cyst จาก MSSQL ก่อน map เข้า public.ultrasound_cyst';",
  );

  await pgClient.query(`
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ultrasound_cyst'
      AND column_name = 'old_exam_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_ultrasound_cyst_old_exam_id
      ON public.ultrasound_cyst (old_exam_id);
  END IF;
END $$;
`.trim());
}
