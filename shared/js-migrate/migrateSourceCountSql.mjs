import { bracketMssqlIdent } from "./mssqlConnectConfig.mjs";

/** ตรงกับ mssqlAppointmentReschedulesSelect.mjs */
const APPOINTMENT_RESCHEDULE_ACTIVITY = "ย้ายวันนัด";

function mssqlStringLiteral(value) {
  return `N'${String(value).replace(/'/g, "''")}'`;
}

/**
 * COUNT สำหรับ snapshot migrate:all — ต้องตรงเงื่อนไขที่ migrate จริงจะดึง
 * @param {string} profileName
 * @param {string} schema
 * @param {string} table
 */
export function buildMigrateSourceCountSql(profileName, schema, table) {
  const sourceObject = `${bracketMssqlIdent(schema)}.${bracketMssqlIdent(table)} WITH (NOLOCK)`;

  if (profileName === "appointment_reschedules") {
    return `SELECT COUNT_BIG(1) AS total FROM ${sourceObject} WHERE [Activity] = ${mssqlStringLiteral(APPOINTMENT_RESCHEDULE_ACTIVITY)}`;
  }

  return `SELECT COUNT_BIG(1) AS total FROM ${sourceObject}`;
}
