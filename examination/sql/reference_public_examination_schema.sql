-- ดึงชนิดคอลัมน์จริงของ public.examination จาก PostgreSQL
-- (Directus อ่าน schema จาก DB นี้ — ใช้เทียบกับ 02_insert_into_clone_examination.sql)
--
-- รันผ่าน psql หรือ kubectl exec ไปที่ pod เช่นเดียวกับ run-migrate-examination.ps1
-- ตัวอย่าง:
--   kubectl -n default exec -i postgresql-0 -- psql -U devuser -d bisinfo_dev_clone -f -

SELECT
  c.ordinal_position AS ord,
  c.column_name,
  c.data_type,
  c.udt_name,
  c.character_maximum_length,
  c.numeric_precision,
  c.is_nullable,
  pg_catalog.col_description(
    (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass,
    c.ordinal_position
  ) AS comment
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND c.table_name = 'examination'
ORDER BY c.ordinal_position;
