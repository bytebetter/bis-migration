-- ใช้กับ run-migrate-examination.ps1: pipe เข้า psql -f - เพื่อเขียนรายการ missing ทั้งหมด (ไม่จำกัดแถว)
SELECT s.exam_id,
  CASE
    WHEN NULLIF(migrate_stg.norm_exam_id(s.exam_id), '') !~ '^[0-9]+$' THEN 'invalid_exam_id'
    WHEN migrate_stg.norm_pid(s.pid) = '' THEN 'empty_pid'
    WHEN NOT EXISTS (
      SELECT 1 FROM public.patient_info p
      WHERE migrate_stg.norm_pid(p.pid::text) = migrate_stg.norm_pid(s.pid)
    ) THEN 'patient_not_found'
    ELSE 'unknown'
  END AS reason
FROM migrate_stg.examination_mssql s
LEFT JOIN public.examination e
  ON e.old_exam_id = (NULLIF(migrate_stg.norm_exam_id(s.exam_id), '')::bigint)::text
WHERE e.id IS NULL
ORDER BY s.exam_id;
