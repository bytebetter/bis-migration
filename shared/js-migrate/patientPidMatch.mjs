/**
 * จับคู่ PID ต้นทาง → public.patient_info แบบไม่สนตัวพิมพ์ (ให้ตรงกับ MSSQL collation CI)
 *
 * ต้นทางเก็บ PID คนเดียวกันต่างตัวพิมพ์ได้ (เช่น SCHEDULE.PID = 'm1175' แต่ patient_info.PID = 'M1175')
 * ถ้าเทียบแบบตรงตัว จะหาไม่เจอ → ได้ placeholder "ไม่ทราบชื่อ" และข้อมูลลูกผูกผิดคน
 *
 * ฝั่ง patient_info ใช้ lower(pid::text) / lower(old_db_id::text) ตรงกับ index ที่ ensurePatientInfoPidCiIndexes สร้าง
 */
import { PLACEHOLDER_FIRST_NAME_TH } from "./ensurePlaceholderPatientInfo.mjs";

const PID_CI_INDEXES = [
  { name: "idx_migrate_pi_pid_ci", column: "pid" },
  { name: "idx_migrate_pi_old_db_id_ci", column: "old_db_id" },
];

/** คีย์ JS สำหรับเทียบ PID (ค่าต้อง normalize แล้ว — trim / ตัด BOM) */
export function pidMatchKey(normalizedPid) {
  return String(normalizedPid ?? "").toLowerCase();
}

/**
 * เงื่อนไข: แถว patient_info (alias) ตรงกับ pidSql แบบไม่สนตัวพิมพ์
 * @param {string} alias alias ของ public.patient_info
 * @param {string} pidSql นิพจน์ PID ที่ normalize แล้ว เช่น NULLIF(btrim(s.pid), '')
 * @param {{ includeOldDbId?: boolean }} [opts]
 */
export function patientPidMatchSql(alias, pidSql, { includeOldDbId = true } = {}) {
  const pidMatch = `lower(${alias}.pid::text) = lower(${pidSql})`;
  if (!includeOldDbId) return pidMatch;
  return `(${pidMatch} OR lower(${alias}.old_db_id::text) = lower(${pidSql}))`;
}

/**
 * เงื่อนไข: แถว patient_info (alias) ตรงกับค่าใน array parameter (ค่าต้องผ่าน pidMatchKey แล้ว)
 * @param {string} alias
 * @param {string} param เช่น $1
 */
export function patientPidInArraySql(alias, param, { includeOldDbId = true } = {}) {
  const pidMatch = `lower(${alias}.pid::text) = ANY(${param}::text[])`;
  if (!includeOldDbId) return pidMatch;
  return `(${pidMatch} OR lower(${alias}.old_db_id::text) = ANY(${param}::text[]))`;
}

/** SQL boolean: แถว patient_info (alias) เป็น placeholder */
export function patientIsPlaceholderSql(alias) {
  return `COALESCE(${alias}.first_name_th, '') = '${PLACEHOLDER_FIRST_NAME_TH}'`;
}

/**
 * ORDER BY เมื่อ PID ตรงหลายแถว: แถวจริงก่อน placeholder → pid ตรงตัวพิมพ์ → pid (ไม่สนตัวพิมพ์) ก่อน old_db_id → id
 * @param {string} alias
 * @param {string} pidSql
 */
export function patientPidPreferenceOrderSql(alias, pidSql) {
  return `CASE WHEN ${patientIsPlaceholderSql(alias)} THEN 1 ELSE 0 END,
    CASE
      WHEN ${alias}.pid::text = ${pidSql} THEN 0
      WHEN lower(${alias}.pid::text) = lower(${pidSql}) THEN 1
      ELSE 2
    END,
    ${alias}.id`;
}

/**
 * สร้าง index lower(pid) / lower(old_db_id) บน public.patient_info ถ้ายังไม่มี
 * เช็คจาก catalog ก่อน — ไม่ยิง CREATE INDEX (ซึ่งล็อกตาราง) ซ้ำทุก chunk
 * @param {import("pg").PoolClient} pgClient
 */
export async function ensurePatientInfoPidCiIndexes(pgClient) {
  const { rows } = await pgClient.query(
    `
    SELECT i.name, i.column_name,
           to_regclass('public.' || i.name) IS NOT NULL AS index_exists,
           EXISTS (
             SELECT 1 FROM information_schema.columns c
             WHERE c.table_schema = 'public'
               AND c.table_name = 'patient_info'
               AND c.column_name = i.column_name
           ) AS column_exists
    FROM unnest($1::text[], $2::text[]) AS i(name, column_name)
    `,
    [PID_CI_INDEXES.map((x) => x.name), PID_CI_INDEXES.map((x) => x.column)],
  );
  for (const r of rows) {
    if (r.index_exists || !r.column_exists) continue;
    await pgClient.query(
      `CREATE INDEX IF NOT EXISTS ${r.name} ON public.patient_info (lower(${r.column_name}::text))`,
    );
  }
}
