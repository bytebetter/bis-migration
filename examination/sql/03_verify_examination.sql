-- ตรวจหลัง migrate examination (ไม่ดึงแถว missing ทั้งหมด — จำนวนมากจะทำให้เทอร์มินัลค้าง)

SELECT COUNT(*) AS examination_staging_count FROM migrate_stg.examination_mssql;

SELECT COUNT(*) AS examination_target_count FROM public.examination;

SELECT e.id,
  e.old_exam_id,
  e.old_pid,
  e.patient,
  e.exam_date,
  e.appointment
FROM public.examination e
ORDER BY e.id
LIMIT 20;

-- สรุปจำนวนแถวที่ staging มีแต่ไม่เข้า public (ตาม reason)
SELECT reason, COUNT(*)::bigint AS cnt
FROM (
  SELECT
    CASE
      WHEN NULLIF(migrate_stg.norm_exam_id(s.exam_id), '') !~ '^[0-9]+$' THEN 'invalid_exam_id'
      WHEN migrate_stg.norm_pid(s.pid) = '' THEN 'empty_pid'
      WHEN NOT EXISTS (
        SELECT 1
        FROM public.patient_info p
        WHERE migrate_stg.norm_pid(p.pid::text) = migrate_stg.norm_pid(s.pid)
      ) THEN 'patient_not_found'
      ELSE 'unknown'
    END AS reason
  FROM migrate_stg.examination_mssql s
  LEFT JOIN public.examination e
    ON e.old_exam_id = (NULLIF(migrate_stg.norm_exam_id(s.exam_id), '')::bigint)::text
  WHERE e.id IS NULL
) t
GROUP BY reason
ORDER BY reason;

-- ตัวอย่างแถวที่ไม่เข้า (จำกัด — รายการเต็มอยู่ในไฟล์รายงาน missing)
SELECT s.exam_id,
  s.pid,
  CASE
    WHEN NULLIF(migrate_stg.norm_exam_id(s.exam_id), '') !~ '^[0-9]+$' THEN 'invalid_exam_id'
    WHEN migrate_stg.norm_pid(s.pid) = '' THEN 'empty_pid'
    WHEN NOT EXISTS (
      SELECT 1
      FROM public.patient_info p
      WHERE migrate_stg.norm_pid(p.pid::text) = migrate_stg.norm_pid(s.pid)
    ) THEN 'patient_not_found'
    ELSE 'ok'
  END AS reason
FROM migrate_stg.examination_mssql s
LEFT JOIN public.examination e
  ON e.old_exam_id = (NULLIF(migrate_stg.norm_exam_id(s.exam_id), '')::bigint)::text
WHERE e.id IS NULL
ORDER BY s.exam_id
LIMIT 50;
