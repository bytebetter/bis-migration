-- แปลงจาก migrate_stg.patient_info_mssql -> public.patient_info (bisinfo_dev_clone)
-- กติกา: PID = PK ฝั่ง MSSQL -> ใส่ทั้ง pid และ old_db_id (ข้อความ); วันเกิด พ.ศ. -> ค.ศ. (ปี - 543)
--
-- ก่อนรันรอบใหม่ (ช่วยทดสอบแบบล้างทั้งโซ่): TRUNCATE public.patient_info RESTART IDENTITY CASCADE;
--   ระวัง: CASCADE ล้างตารางที่ FK มาที่ patient — ใช้เฉพาะ clone
--
-- รันกับ DB: bisinfo_dev_clone
--
-- รันซ้ำได้: ลบเฉพาะแถวที่ pid ตรงกับ staging ก่อน INSERT (แก้ปัญหา dup เมื่อรัน migrate ซ้ำโดยไม่ TRUNCATE)
-- ถ้า DELETE ถูกบล็อกเพราะ FK (RESTRICT): ใช้ -TruncateFirst หรือจัดการตารางลูกก่อน

BEGIN;

DELETE FROM public.patient_info p
WHERE EXISTS (
  SELECT 1
  FROM migrate_stg.patient_info_mssql s
  WHERE trim(p.pid) = trim(s.pid)
);

-- sync sequence กับ id ที่เหลือ: ไม่ให้ id ใหม่โดดต่อจากค่า sequence เก่า
-- ตารางว่าง → id ถัดไปเริ่มที่ 1 | ถ้ามีแถวอื่นอยู่ → ต่อจาก max(id)
SELECT setval(
  pg_get_serial_sequence('public.patient_info', 'id'),
  COALESCE((SELECT MAX(id) + 1 FROM public.patient_info), 1),
  false
);

INSERT INTO public.patient_info (
  old_db_id,
  pid,
  prefix_th,
  first_name_th,
  last_name_th,
  date_of_birth,
  marital_status,
  phone_biz,
  phone_home,
  height,
  weight,
  donate_type,
  prefix_en,
  first_name_en,
  last_name_en,
  soc_id,
  hn,
  gender,
  short_note,
  disease,
  mobile_phone,
  email
)
SELECT
  trim(s.pid) AS old_db_id,
  trim(s.pid) AS pid,
  NULLIF(trim(s.prefix), '') AS prefix_th,
  NULLIF(trim(s.name), '') AS first_name_th,
  NULLIF(trim(s.surname), '') AS last_name_th,
  CASE
    WHEN s.date_of_birth_be IS NULL OR trim(s.date_of_birth_be) = '' THEN NULL
    WHEN trim(s.date_of_birth_be) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
      THEN make_date(
        (substring(trim(s.date_of_birth_be) FROM 1 FOR 4))::integer - 543,
        (substring(trim(s.date_of_birth_be) FROM 6 FOR 2))::integer,
        (substring(trim(s.date_of_birth_be) FROM 9 FOR 2))::integer
      )
    ELSE NULL
  END AS date_of_birth,
  NULLIF(trim(s.single), '') AS marital_status,
  NULLIF(trim(s.phone_biz), '') AS phone_biz,
  NULLIF(trim(s.phone_home), '') AS phone_home,
  CASE
    WHEN NULLIF(trim(s.height), '') IS NOT NULL AND trim(s.height) ~ '^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$'
      THEN trim(s.height)::real
    ELSE NULL
  END AS height,
  CASE
    WHEN NULLIF(trim(s.weight), '') IS NOT NULL AND trim(s.weight) ~ '^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$'
      THEN trim(s.weight)::real
    ELSE NULL
  END AS weight,
  CASE
    WHEN NULLIF(trim(s.donate_type), '') IS NOT NULL AND trim(s.donate_type) ~ '^[0-9]+$'
      THEN trim(s.donate_type)::integer
    ELSE NULL
  END AS donate_type,
  NULLIF(trim(s.eng_prefix), '') AS prefix_en,
  NULLIF(trim(s.eng_name), '') AS first_name_en,
  NULLIF(trim(s.eng_surname), '') AS last_name_en,
  NULLIF(trim(s.soc_id), '') AS soc_id,
  NULLIF(trim(s.hn), '') AS hn,
  NULLIF(trim(s.gender), '') AS gender,
  NULLIF(trim(s.short_note), '') AS short_note,
  NULLIF(trim(s.disease), '') AS disease,
  NULLIF(trim(s.mobile_phone), '') AS mobile_phone,
  NULLIF(trim(s.email), '') AS email
FROM migrate_stg.patient_info_mssql s;

COMMIT;
