/**
 * staging + คอลัมน์/ index ที่ step center_income ต้องใช้
 *
 * public.center_income.old_db_id ("income:ID" / "income2:ID") สร้างเป็นฟิลด์ใน Directus — สคริปต์สร้างแค่ index
 * ไว้เทียบแถวเดิมทุกรอบ
 * index lookup patient_info สร้างจากสคริปต์เอง (IF NOT EXISTS) — ไม่อยู่ใน dump ของ Directus จึงหายทุกครั้งที่ restore
 */

import { ensurePatientInfoPidCiIndexes } from "../../shared/js-migrate/patientPidMatch.mjs";

/** คอลัมน์ staging = alias ใน mssqlCenterIncomeSelect.mjs (เก็บเป็นข้อความทั้งหมด แปลงตอนเขียนปลายทาง) */
export const CENTER_INCOME_STAGING_COLUMNS = [
  "old_db_id",
  "income_date",
  "income_type",
  "donate_type",
  "pid",
  "full_name",
  "receipt",
  "receipt_no",
  "mobile",
  "location_id",
];

export const CENTER_INCOME_STAGING_TABLE = "migrate_stg.center_income_mssql";

/**
 * index เทียบแถวเดิมด้วย old_db_id — คอลัมน์สร้างใน Directus (ไม่ ADD COLUMN จากสคริปต์)
 * ยังไม่มีคอลัมน์ = ข้าม แล้วให้ centerIncomeMapping หยุดพร้อมบอกให้สร้างฟิลด์ก่อน
 */
export async function ensureCenterIncomeOldDbIdIndex(pgClient) {
  await pgClient.query(`
    DO $ci_old_db$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'center_income' AND column_name = 'old_db_id'
      ) THEN
        CREATE INDEX IF NOT EXISTS idx_center_income_old_db_id
        ON public.center_income (old_db_id)
        WHERE old_db_id IS NOT NULL;
      END IF;
    END
    $ci_old_db$;
  `);
}

export async function ensureCenterIncomePipelineDdl(pgClient) {
  // r_patient = patient_info.id ที่ resolve ได้ของ chunk นั้น (คำนวณครั้งเดียว ใช้ทั้ง insert / เติม relation / field issue)
  const CREATE_STAGING = `
CREATE TABLE ${CENTER_INCOME_STAGING_TABLE} (
  ${CENTER_INCOME_STAGING_COLUMNS.map((c) => (c === "old_db_id" ? `"${c}" TEXT NOT NULL` : `"${c}" TEXT`)).join(",\n  ")},
  r_patient BIGINT,
  PRIMARY KEY ("old_db_id")
);
`.trim();

  await pgClient.query("CREATE SCHEMA IF NOT EXISTS migrate_stg;");
  await pgClient.query(`DROP TABLE IF EXISTS ${CENTER_INCOME_STAGING_TABLE};`);
  await pgClient.query(CREATE_STAGING);
  await pgClient.query(
    `COMMENT ON TABLE ${CENTER_INCOME_STAGING_TABLE} IS 'Staging: income + income2 จาก MSSQL ก่อน map เข้า public.center_income';`,
  );
  await ensureCenterIncomeOldDbIdIndex(pgClient);
  // lookup patient_info แบบไม่สนตัวพิมพ์ (centerIncomeMapping)
  await ensurePatientInfoPidCiIndexes(pgClient);
}
