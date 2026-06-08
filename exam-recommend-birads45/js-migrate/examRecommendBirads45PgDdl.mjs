export async function ensureExamRecommendBirads45PipelineDdl(pgClient) {
  const CREATE_STAGING_TABLE = `
CREATE TABLE migrate_stg.exam_recommend_birads45_mssql (
  exam_id TEXT NOT NULL,
  exam_date TEXT,
  pid TEXT,
  recommend_id TEXT NOT NULL,
  biopsy_procedure TEXT,
  breast_side TEXT,
  location TEXT,
  PRIMARY KEY (exam_id, recommend_id)
);
`.trim();

  await pgClient.query("CREATE SCHEMA IF NOT EXISTS migrate_stg;");
  await pgClient.query("DROP TABLE IF EXISTS migrate_stg.exam_recommend_birads45_mssql;");
  await pgClient.query(CREATE_STAGING_TABLE);
  await pgClient.query(
    "COMMENT ON TABLE migrate_stg.exam_recommend_birads45_mssql IS 'Staging: EXAM_Recommend_BIRADS45 จาก MSSQL ก่อน update recommendation_des';",
  );

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
