-- แปลงที่อยู่จาก migrate_stg.patient_info_mssql -> ตาราง Directus (ลูกของ patient_info)
-- แมป MSSQL -> Directus:
--   Address  -> address
--   SubArea  -> sub_district
--   Area     -> district
--   Province -> province
--   Zip      -> zipcode
--   Address2 -> address2
--
-- รันหลัง 02_insert_into_clone_patient_info.sql (ต้องมีแถวใน public.patient_info แล้ว)
--
-- ทุกครั้งก่อน insert: ลบ address เดิมของ patient ที่อยู่ใน staging ชุดนี้ แล้ว sync sequence id
-- ใช้ migrate_stg.norm_pid() ให้ตรงกับ 02 (กันซ้ำเมื่อรัน migrate ซ้ำ)

BEGIN;

DELETE FROM public.address a
WHERE EXISTS (
  SELECT 1
  FROM public.patient_info p
  JOIN migrate_stg.patient_info_mssql s
    ON migrate_stg.norm_pid(p.pid::text) = migrate_stg.norm_pid(s.pid)
  WHERE p.id = a.patient_info
);

SELECT setval(
  pg_get_serial_sequence('public.address', 'id'),
  COALESCE((SELECT MAX(id) + 1 FROM public.address), 1),
  false
);

INSERT INTO public.address (
  status,
  address,
  sub_district,
  district,
  province,
  zipcode,
  address2,
  patient_info,
  from_old_db
)
SELECT
  'published',
  NULLIF(trim(s.address), ''),
  NULLIF(trim(s.sub_area), ''),
  NULLIF(trim(s.area), ''),
  NULLIF(trim(s.province), ''),
  NULLIF(trim(s.zip), ''),
  NULLIF(trim(s.address2), ''),
  p.id,
  TRUE
FROM (
  SELECT DISTINCT ON (migrate_stg.norm_pid(s.pid))
    s.*
  FROM migrate_stg.patient_info_mssql s
  WHERE migrate_stg.norm_pid(s.pid) <> ''
  ORDER BY migrate_stg.norm_pid(s.pid)
) s
JOIN public.patient_info p
  ON migrate_stg.norm_pid(p.pid::text) = migrate_stg.norm_pid(s.pid)
WHERE
  NULLIF(trim(s.address), '') IS NOT NULL
  OR NULLIF(trim(s.sub_area), '') IS NOT NULL
  OR NULLIF(trim(s.area), '') IS NOT NULL
  OR NULLIF(trim(s.province), '') IS NOT NULL
  OR NULLIF(trim(s.zip), '') IS NOT NULL
  OR NULLIF(trim(s.address2), '') IS NOT NULL;

COMMIT;
