const NORM_PID_FN = `
CREATE OR REPLACE FUNCTION migrate_stg.norm_pid(t text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT btrim(regexp_replace(coalesce($1, ''), '^' || chr(65279), ''))
$$;
`.trim();

const CREATE_PATIENT_INFO_STAGING_TABLE = `
CREATE TABLE migrate_stg.patient_info_mssql (
  pid TEXT NOT NULL PRIMARY KEY,
  prefix TEXT,
  name TEXT,
  surname TEXT,
  date_of_birth_be TEXT,
  single TEXT,
  address TEXT,
  sub_area TEXT,
  area TEXT,
  province TEXT,
  zip TEXT,
  phone_biz TEXT,
  phone_home TEXT,
  height TEXT,
  weight TEXT,
  current_breast_compo TEXT,
  current_implant_type TEXT,
  last_exam_date TEXT,
  mobile TEXT,
  mobile_updated TEXT,
  donate_type TEXT,
  eng_prefix TEXT,
  eng_name TEXT,
  eng_surname TEXT,
  soc_id TEXT,
  hn TEXT,
  gender TEXT,
  address2 TEXT,
  short_note TEXT,
  disease TEXT,
  mobile_phone TEXT,
  email TEXT
);
`.trim();

export async function ensurePatientInfoStagingDdl(pgClient) {
  await pgClient.query("CREATE SCHEMA IF NOT EXISTS migrate_stg;");
  await pgClient.query(NORM_PID_FN);
  await pgClient.query("DROP TABLE IF EXISTS migrate_stg.patient_info_mssql;");
  await pgClient.query(CREATE_PATIENT_INFO_STAGING_TABLE);
  await pgClient.query(
    "COMMENT ON TABLE migrate_stg.patient_info_mssql IS 'Staging: ข้อมูล patient จาก MSSQL ก่อนแปลงเข้า public.patient_info';"
  );
}
