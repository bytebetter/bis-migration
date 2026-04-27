const CREATE_APPOINTMENT_STAGING_TABLE = `
CREATE TABLE migrate_stg.appointment_mssql (
  schedule_datetime TEXT,
  schedule_number TEXT,
  prefix TEXT,
  name TEXT,
  surname TEXT,
  payment_type TEXT,
  patient_type TEXT,
  pid TEXT,
  age TEXT,
  receive_date TEXT,
  login_name TEXT,
  memo_detail TEXT,
  fail TEXT,
  telephone TEXT,
  inventional TEXT,
  modified_date TEXT,
  modified_user TEXT,
  biopsy_proc TEXT,
  referring_md TEXT,
  biopsy_comment TEXT,
  biopsy_radiologist TEXT,
  schedule_id TEXT PRIMARY KEY,
  mobile TEXT,
  location_id TEXT,
  is_online TEXT,
  have_doc TEXT,
  have_cd TEXT,
  right_id TEXT
);
`.trim();

export async function ensureAppointmentStagingDdl(pgClient) {
  await pgClient.query("CREATE SCHEMA IF NOT EXISTS migrate_stg;");
  await pgClient.query("DROP TABLE IF EXISTS migrate_stg.appointment_mssql;");
  await pgClient.query(CREATE_APPOINTMENT_STAGING_TABLE);
  await pgClient.query(
    "COMMENT ON TABLE migrate_stg.appointment_mssql IS 'Staging: ข้อมูล schedule จาก MSSQL ก่อนแปลงเข้า public.appointment';",
  );
}
