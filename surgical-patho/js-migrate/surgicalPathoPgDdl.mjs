/**
 * staging + index ที่ step surgical_patho ต้องใช้
 *
 * ไม่สร้าง index บน public.surgical_patho — ตารางปลายทางหลักหมื่นแถว เทียบคีย์แบบ hash join เร็วพอ
 * index บนตารางที่ใช้ resolve relation สร้างจากสคริปต์เอง (IF NOT EXISTS, ชื่อเดียวกับ step เจ้าของตาราง)
 * ไม่ให้คนสร้างมือบน prod — ของพวกนี้ไม่อยู่ใน dump ของ Directus จึงหายทุกครั้งที่ restore baseline
 */

import { ensurePatientInfoPidCiIndexes } from "../../shared/js-migrate/patientPidMatch.mjs";

/** คอลัมน์ staging = ชื่อคอลัมน์ปลายทางตรงตัว (ดู alias ใน mssqlSurgicalPathoSelect.mjs) */
export const SURGICAL_PATHO_STAGING_COLUMNS = [
  "old_pid",
  "old_surgical_id",
  "surgical_date",
  "surgical_patho_code",
  "surgical_patho_code_full_desc",
  "old_exam_id",
  "old_biopsy_id",
  "location",
  "radiologist",
  "discordance",
  "old_last_exam_id",
];

export const SURGICAL_PATHO_STAGING_TABLE = "migrate_stg.surgical_patho_mssql";

export async function ensureSurgicalPathoPipelineDdl(pgClient) {
  const dataCols = SURGICAL_PATHO_STAGING_COLUMNS.filter(
    (c) => c !== "old_pid" && c !== "old_surgical_id",
  );
  // r_* = id ปลายทางที่ resolve ได้ของ chunk นั้น (คำนวณครั้งเดียว ใช้ทั้ง insert / เติม relation / field issue)
  const CREATE_STAGING = `
CREATE TABLE ${SURGICAL_PATHO_STAGING_TABLE} (
  old_pid TEXT NOT NULL,
  old_surgical_id TEXT NOT NULL,
${dataCols.map((c) => `  ${c} TEXT,`).join("\n")}
  r_patient BIGINT,
  r_exam BIGINT,
  r_procedure BIGINT,
  r_last_exam BIGINT,
  PRIMARY KEY (old_pid, old_surgical_id)
);
`.trim();

  await pgClient.query("CREATE SCHEMA IF NOT EXISTS migrate_stg;");
  await pgClient.query(`DROP TABLE IF EXISTS ${SURGICAL_PATHO_STAGING_TABLE};`);
  await pgClient.query(CREATE_STAGING);
  await pgClient.query(
    `COMMENT ON TABLE ${SURGICAL_PATHO_STAGING_TABLE} IS 'Staging: SURGICAL_PATHO จาก MSSQL ก่อน map เข้า public.surgical_patho';`,
  );

  // exam / last_exam: ชื่อเดียวกับที่ step examination สร้าง → ถ้ามีแล้วไม่สร้างซ้ำ
  // procedure: ชื่อ + partial เดียวกับ procedurePgDdl.mjs
  await pgClient.query(
    `
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'examination' AND column_name = 'old_exam_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_examination_old_exam_id
      ON public.examination (old_exam_id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'procedure' AND column_name = 'old_db_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_procedure_old_db_id
      ON public."procedure" (old_db_id)
      WHERE old_db_id IS NOT NULL;
  END IF;
END $$;
`.trim(),
  );
  // lookup patient_info แบบไม่สนตัวพิมพ์ (surgicalPathoMapping)
  await ensurePatientInfoPidCiIndexes(pgClient);
}
