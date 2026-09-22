/**
 * staging ที่ step mobile_location ต้องใช้
 *
 * ไม่สร้าง index บน public.mobile_location — ตารางปลายทางมีหลักร้อยแถว
 * ทุก query ของ step นี้ scan ทั้งตารางเร็วกว่าค่าดูแล index (ดู patient_info(old_db_id) ที่หายทุกครั้งที่ restore)
 */

/** คอลัมน์ staging = ชื่อคอลัมน์ปลายทางตรงตัว (ดู alias ใน mssqlMobileLocationSelect.mjs) */
export const MOBILE_LOCATION_STAGING_COLUMNS = ["old_id", "name"];

export const MOBILE_LOCATION_STAGING_TABLE = "migrate_stg.mobile_location_mssql";

export async function ensureMobileLocationPipelineDdl(pgClient) {
  const CREATE_STAGING = `
CREATE TABLE ${MOBILE_LOCATION_STAGING_TABLE} (
  old_id TEXT NOT NULL,
  name TEXT,
  PRIMARY KEY (old_id)
);
`.trim();

  await pgClient.query("CREATE SCHEMA IF NOT EXISTS migrate_stg;");
  await pgClient.query(
    `DROP TABLE IF EXISTS ${MOBILE_LOCATION_STAGING_TABLE};`,
  );
  await pgClient.query(CREATE_STAGING);
  await pgClient.query(
    `COMMENT ON TABLE ${MOBILE_LOCATION_STAGING_TABLE} IS 'Staging: MOBILE_LOCATION จาก MSSQL ก่อน map เข้า public.mobile_location';`,
  );
}

/** ปลายทางมีข้อมูลจาก baseline (COPY ใส่ id ตรงๆ) — ดัน sequence ให้พ้น MAX(id) ก่อน insert */
export async function syncMobileLocationIdSequence(pgClient) {
  await pgClient.query(`
    SELECT setval(
      pg_get_serial_sequence('public.mobile_location', 'id'),
      COALESCE((SELECT MAX(id) + 1 FROM public.mobile_location), 1),
      false
    )
    WHERE pg_get_serial_sequence('public.mobile_location', 'id') IS NOT NULL;
  `);
}
