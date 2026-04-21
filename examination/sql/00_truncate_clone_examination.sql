-- ล้าง public.examination ใน clone (อันตราย — ใช้เฉพาะ bisinfo_dev_clone)
-- CASCADE: ล้างตารางลูกที่ FK มาที่ examination ถ้ามี

BEGIN;

TRUNCATE TABLE public.examination RESTART IDENTITY CASCADE;

COMMIT;
