export async function ensureAppointmentReschedulesTargetIndexes(pgClient) {
  await pgClient.query(`
    CREATE INDEX IF NOT EXISTS idx_appointment_reschedules_appt_dt
      ON public.appointment_reschedules (appointment, appointment_datetime)
      WHERE appointment IS NOT NULL AND appointment_datetime IS NOT NULL;
  `);
}

/**
 * เตรียมก่อน migrate — ไม่สร้าง staging table (แม็ปจาก MSSQL recordset ตรงๆ เพื่อลด I/O Postgres ต่อ chunk)
 */
export async function ensureAppointmentReschedulesPipelineDdl(pgClient) {
  await pgClient.query("CREATE SCHEMA IF NOT EXISTS migrate_stg;");
}
