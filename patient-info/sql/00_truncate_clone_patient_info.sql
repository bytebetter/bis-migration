-- ใช้เฉพาะใน bisinfo_dev_clone เมื่อต้องการรัน migration รอบใหม่ (ล้าง patient ทั้งตาราง)
-- อันตราย: จะลบข้อมูลทั้งหมดในตาราง public.patient_info
-- CASCADE: ล้างตารางที่ FK มาที่ patient_info ด้วย (เช่น address) — เฉพาะ clone เท่านั้น
-- ตรวจสอบว่าเชื่อมต่อ DB ที่ถูกต้อง (เช่น bisinfo_dev_clone) ก่อนรันเสมอ

BEGIN;

TRUNCATE TABLE public.patient_info RESTART IDENTITY CASCADE;

COMMIT;
