export async function ensureMamCalPipelineDdl(pgClient) {
  const CREATE_MAM_CAL_STAGING_TABLE = `
CREATE TABLE migrate_stg.mammogram_cal_mssql (
  described_cal_id TEXT NOT NULL,
  exam_id TEXT NOT NULL,
  exam_date TEXT,
  pid TEXT,
  type TEXT,
  type_des TEXT,
  distribution TEXT,
  distribution_des TEXT,
  r_position TEXT,
  r_position_des TEXT,
  l_position TEXT,
  l_position_des TEXT,
  l_position_clock TEXT,
  r_position_clock TEXT,
  PRIMARY KEY (exam_id, described_cal_id)
);
`.trim();

  await pgClient.query("CREATE SCHEMA IF NOT EXISTS migrate_stg;");
  await pgClient.query("DROP TABLE IF EXISTS migrate_stg.mammogram_cal_mssql;");
  await pgClient.query(CREATE_MAM_CAL_STAGING_TABLE);
  await pgClient.query(
    "COMMENT ON TABLE migrate_stg.mammogram_cal_mssql IS 'Staging: mammogram_cal จาก MSSQL ก่อน map เข้า public.mammogram_cal';",
  );

  await pgClient.query(`
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'mammogram_cal'
      AND column_name = 'old_exam_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_mammogram_cal_old_exam_id
      ON public.mammogram_cal (old_exam_id);
  END IF;
END $$;
`.trim());
}
