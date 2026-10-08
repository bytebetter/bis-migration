/**
 * staging + index ที่ step special_case ต้องใช้
 *
 * ไม่สร้าง index บน public.special_case — ตารางปลายทางหลักพันแถว เทียบคีย์แบบ hash join เร็วพอ
 * index lookup patient_info สร้างจากสคริปต์เอง (IF NOT EXISTS) ไม่ให้คนสร้างมือบน prod
 * — ของพวกนี้ไม่อยู่ใน dump ของ Directus จึงหายทุกครั้งที่ restore baseline
 */

import { ensurePatientInfoPidCiIndexes } from "../../shared/js-migrate/patientPidMatch.mjs";

/** คอลัมน์ staging = ชื่อคอลัมน์ปลายทางตรงตัว (ดู alias ใน mssqlSpecialCaseSelect.mjs) */
export const SPECIAL_CASE_STAGING_COLUMNS = [
  "old_pid",
  "sequence",
  "special_case_point",
  "special_case_point_des",
  "special_case_detail",
];

export const SPECIAL_CASE_STAGING_TABLE = "migrate_stg.special_case_mssql";

export async function ensureSpecialCasePipelineDdl(pgClient) {
  // r_patient = patient_info.id ที่ resolve ได้ของ chunk นั้น (คำนวณครั้งเดียว ใช้ทั้ง insert / เติม relation / field issue)
  const CREATE_STAGING = `
CREATE TABLE ${SPECIAL_CASE_STAGING_TABLE} (
  "old_pid" TEXT NOT NULL,
  "sequence" TEXT NOT NULL,
  "special_case_point" TEXT,
  "special_case_point_des" TEXT,
  "special_case_detail" TEXT,
  r_patient BIGINT,
  PRIMARY KEY ("old_pid", "sequence")
);
`.trim();

  await pgClient.query("CREATE SCHEMA IF NOT EXISTS migrate_stg;");
  await pgClient.query(`DROP TABLE IF EXISTS ${SPECIAL_CASE_STAGING_TABLE};`);
  await pgClient.query(CREATE_STAGING);
  await pgClient.query(
    `COMMENT ON TABLE ${SPECIAL_CASE_STAGING_TABLE} IS 'Staging: SPECIAL_CASE จาก MSSQL ก่อน map เข้า public.special_case';`,
  );
  // lookup patient_info แบบไม่สนตัวพิมพ์ (specialCaseMapping)
  await ensurePatientInfoPidCiIndexes(pgClient);
}
