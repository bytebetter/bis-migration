-- Staging สำหรับข้อมูลจาก MSSQL (export เป็น CSV แล้ว COPY เข้ามา)
-- รันกับ DB: bisinfo_dev_clone
--
-- รัน:
--   kubectl -n default exec -i postgresql-0 -- psql -U devuser -d bisinfo_dev_clone -f -
--   (หรือ pipe ไฟล์นี้เข้า psql)

CREATE SCHEMA IF NOT EXISTS migrate_stg;

DROP TABLE IF EXISTS migrate_stg.patient_info_mssql;

CREATE TABLE migrate_stg.patient_info_mssql (
  pid TEXT NOT NULL PRIMARY KEY,
  prefix TEXT,
  name TEXT,
  surname TEXT,
  -- เก็บวันเกิดแบบดิบจาก MSSQL (พ.ศ.) เช่น "2542-01-01 00:00:00.000"
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

COMMENT ON TABLE migrate_stg.patient_info_mssql IS 'Staging: ข้อมูล patient จาก MSSQL ก่อนแปลงเข้า public.patient_info';
