export async function ensurePacsSyncInfoPipelineDdl(pgClient) {
  const CREATE_STAGING = `
CREATE TABLE migrate_stg.pacs_sync_info_mssql (
  accession_id TEXT PRIMARY KEY,
  pid TEXT,
  exam_id TEXT,
  dl_dt TEXT,
  modality TEXT,
  seriesperformed TEXT,
  status TEXT,
  isnormalstudy TEXT,
  studyno TEXT,
  studydescription TEXT,
  ismarkdel TEXT,
  pacssynctime TEXT,
  worklistcode TEXT,
  riscode TEXT,
  syncfilename TEXT
);
`.trim();

  await pgClient.query("CREATE SCHEMA IF NOT EXISTS migrate_stg;");
  await pgClient.query(
    "DROP TABLE IF EXISTS migrate_stg.pacs_sync_info_mssql;",
  );
  await pgClient.query(CREATE_STAGING);
  await pgClient.query(
    "COMMENT ON TABLE migrate_stg.pacs_sync_info_mssql IS 'Staging: pacs_sync_info จาก MSSQL ก่อน map เข้า public.pacs_sync_info';",
  );

  await pgClient.query(`
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'pacs_sync_info'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_pacs_sync_info_accession_id
      ON public.pacs_sync_info (accession_id);
  END IF;
END $$;
`.trim());

  await pgClient.query(`
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'patient_info'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'patient_info' AND column_name = 'pid'
    ) THEN
      CREATE INDEX IF NOT EXISTS idx_migrate_pi_pid
        ON public.patient_info (pid);
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'patient_info' AND column_name = 'old_db_id'
    ) THEN
      CREATE INDEX IF NOT EXISTS idx_migrate_pi_old_db_id
        ON public.patient_info (old_db_id);
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'examination'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'examination' AND column_name = 'old_exam_id'
    ) THEN
      CREATE INDEX IF NOT EXISTS idx_migrate_exam_old_exam_id
        ON public.examination (old_exam_id);
    END IF;
  END IF;
END $$;
`.trim());
}
