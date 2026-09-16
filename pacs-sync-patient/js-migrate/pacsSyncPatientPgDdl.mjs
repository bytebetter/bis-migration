/**
 * staging + index ที่ step pacs_sync_patient ต้องใช้
 *
 * index บน patient_info สร้างจากสคริปต์เอง (IF NOT EXISTS) ไม่ให้คนสร้างมือบน prod —
 * ของพวกนี้ไม่อยู่ใน dump ของ Directus จึงหายทุกครั้งที่ restore baseline
 */

/** คอลัมน์ staging = ชื่อคอลัมน์ปลายทางตรงตัว (ดู alias ใน mssqlPacsSyncPatientSelect.mjs) */
export const PACS_SYNC_PATIENT_STAGING_COLUMNS = [
  "update_time",
  "old_name",
  "old_middle_name",
  "old_surname",
  "old_engname",
  "old_eng_middle_name",
  "old_eng_surname",
  "old_old_pid",
  "old_date_of_birth",
  "old_gender",
  "name",
  "middle_name",
  "surname",
  "engname",
  "eng_middle_name",
  "eng_surname",
  "old_pid",
  "date_of_birth",
  "gender",
  "is_generated",
];

export async function ensurePacsSyncPatientPipelineDdl(pgClient) {
  const CREATE_STAGING = `
CREATE TABLE migrate_stg.pacs_sync_patient_mssql (
${PACS_SYNC_PATIENT_STAGING_COLUMNS.map((c) => `  ${c} TEXT`).join(",\n")}
);
`.trim();

  await pgClient.query("CREATE SCHEMA IF NOT EXISTS migrate_stg;");
  // ตาราง log ไม่มี PK — staging ไม่ตั้ง PRIMARY KEY ใดๆ ให้แถวซ้ำเข้ามาได้ครบตามต้นทาง
  await pgClient.query(
    "DROP TABLE IF EXISTS migrate_stg.pacs_sync_patient_mssql;",
  );
  await pgClient.query(CREATE_STAGING);
  await pgClient.query(
    "COMMENT ON TABLE migrate_stg.pacs_sync_patient_mssql IS 'Staging: PACS_SYNC_PATIENT จาก MSSQL ก่อน map เข้า public.pacs_sync_patient';",
  );

  await pgClient.query(
    `
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
END $$;
`.trim(),
  );
}

/** index ปลายทางสำหรับงานตามหลัง (ค้น log ของคนไข้) — สร้างหลัง migrate จบ */
export async function ensurePacsSyncPatientTargetIndexes(pgClient) {
  await pgClient.query(`
    CREATE INDEX IF NOT EXISTS idx_pacs_sync_patient_patient_update_time
      ON public.pacs_sync_patient (patient, update_time)
      WHERE patient IS NOT NULL;
  `);
}
