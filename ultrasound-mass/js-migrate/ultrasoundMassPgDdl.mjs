export async function ensureUltrasoundMassPipelineDdl(pgClient) {
  const CREATE_ULTRASOUND_MASS_STAGING_TABLE = `
CREATE TABLE migrate_stg.ultrasound_mass_mssql (
  described_mass_id TEXT NOT NULL,
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
  cal_in_mass TEXT,
  l_position TEXT,
  l_position_des TEXT,
  r_position TEXT,
  r_position_des TEXT,
  l_position_clock TEXT,
  r_position_clock TEXT,
  orientation TEXT,
  orientation_des TEXT,
  posterior_features TEXT,
  posterior_features_des TEXT,
  vascularity TEXT,
  vascularity_des TEXT,
  elasticity TEXT,
  elasticity_des TEXT,
  PRIMARY KEY (exam_id, described_mass_id)
);
`.trim();

  await pgClient.query("CREATE SCHEMA IF NOT EXISTS migrate_stg;");
  await pgClient.query("DROP TABLE IF EXISTS migrate_stg.ultrasound_mass_mssql;");
  await pgClient.query(CREATE_ULTRASOUND_MASS_STAGING_TABLE);
  await pgClient.query(
    "COMMENT ON TABLE migrate_stg.ultrasound_mass_mssql IS 'Staging: ultrasound_mass จาก MSSQL ก่อน map เข้า public.ultrasound_mass';",
  );

  await pgClient.query(`
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ultrasound_mass'
      AND column_name = 'old_exam_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_ultrasound_mass_old_exam_id
      ON public.ultrasound_mass (old_exam_id);
  END IF;
END $$;
`.trim());
}
