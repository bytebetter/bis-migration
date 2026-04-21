-- ตรวจหลัง import เข้า bisinfo_dev_clone (รันใน DB เดียวกัน)

SELECT COUNT(*) AS patient_row_count FROM public.patient_info;

SELECT pid, old_db_id, date_of_birth, first_name_th, last_name_th
FROM public.patient_info
ORDER BY id
LIMIT 20;

-- ตัวอย่าง: หาแถวที่วันเกิดว่างทั้งที่ staging มีค่า
SELECT s.pid
FROM migrate_stg.patient_info_mssql s
LEFT JOIN public.patient_info p ON migrate_stg.norm_pid(p.pid::text) = migrate_stg.norm_pid(s.pid)
WHERE p.id IS NULL;
