/*
  center_income: income2 กับแถวที่ก๊อปไปไว้ใน income (Income_ID + 364480) ต่างกันที่คอลัมน์ไหน
  ใช้ยืนยันว่าคู่ที่ข้อมูลไม่ตรงคือรายการเดียวกันที่ถูกแก้ใน income ทีหลัง (migrate ตัด income2 ที่มีคู่ทิ้ง เก็บของ income)
  ช่อง a_* = income2, b_* = income  (diff_* = 1 คือช่องนั้นต่างกัน)
*/
USE [BISInfo];

WITH a AS (
  SELECT TRY_CONVERT(BIGINT, x.[Income_ID]) + 364480 AS k, x.[Income_ID] AS id,
    NULLIF(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(30), x.[Income_date], 121))), N''), N'NULL') COLLATE DATABASE_DEFAULT AS d,
    COALESCE(CONVERT(NVARCHAR(20), TRY_CONVERT(BIGINT, x.[Income_type])), NULLIF(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(50), x.[Income_type]))), N''), N'NULL') COLLATE DATABASE_DEFAULT) COLLATE DATABASE_DEFAULT AS it,
    COALESCE(CONVERT(NVARCHAR(20), TRY_CONVERT(BIGINT, x.[Donate_type])), NULLIF(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(50), x.[Donate_type]))), N''), N'NULL') COLLATE DATABASE_DEFAULT) COLLATE DATABASE_DEFAULT AS dt,
    COALESCE(CONVERT(NVARCHAR(100), TRY_CONVERT(DECIMAL(19,4), x.[Receipt])), NULLIF(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(100), x.[Receipt]))), N''), N'NULL') COLLATE DATABASE_DEFAULT) COLLATE DATABASE_DEFAULT AS rc,
    COALESCE(CONVERT(NVARCHAR(20), TRY_CONVERT(BIGINT, x.[Location_ID])), NULLIF(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(50), x.[Location_ID]))), N''), N'NULL') COLLATE DATABASE_DEFAULT) COLLATE DATABASE_DEFAULT AS loc,
    NULLIF(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(255), x.[PID]))), N''), N'NULL') COLLATE DATABASE_DEFAULT AS pid,
    NULLIF(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(4000), x.[FullName]))), N''), N'NULL') COLLATE DATABASE_DEFAULT AS fn,
    NULLIF(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(255), x.[Receipt_No]))), N''), N'NULL') COLLATE DATABASE_DEFAULT AS rn,
    COALESCE(CONVERT(NVARCHAR(20), TRY_CONVERT(BIGINT, x.[Mobile])), NULLIF(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(50), x.[Mobile]))), N''), N'NULL') COLLATE DATABASE_DEFAULT) COLLATE DATABASE_DEFAULT AS mob
  FROM dbo.income2 x WITH (NOLOCK)
),
b AS (
  SELECT TRY_CONVERT(BIGINT, x.[Income_ID]) AS k, x.[Income_ID] AS id,
    NULLIF(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(30), x.[Income_date], 121))), N''), N'NULL') COLLATE DATABASE_DEFAULT AS d,
    COALESCE(CONVERT(NVARCHAR(20), TRY_CONVERT(BIGINT, x.[Income_type])), NULLIF(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(50), x.[Income_type]))), N''), N'NULL') COLLATE DATABASE_DEFAULT) COLLATE DATABASE_DEFAULT AS it,
    COALESCE(CONVERT(NVARCHAR(20), TRY_CONVERT(BIGINT, x.[Donate_type])), NULLIF(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(50), x.[Donate_type]))), N''), N'NULL') COLLATE DATABASE_DEFAULT) COLLATE DATABASE_DEFAULT AS dt,
    COALESCE(CONVERT(NVARCHAR(100), TRY_CONVERT(DECIMAL(19,4), x.[Receipt])), NULLIF(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(100), x.[Receipt]))), N''), N'NULL') COLLATE DATABASE_DEFAULT) COLLATE DATABASE_DEFAULT AS rc,
    COALESCE(CONVERT(NVARCHAR(20), TRY_CONVERT(BIGINT, x.[Location_ID])), NULLIF(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(50), x.[Location_ID]))), N''), N'NULL') COLLATE DATABASE_DEFAULT) COLLATE DATABASE_DEFAULT AS loc,
    NULLIF(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(255), x.[PID]))), N''), N'NULL') COLLATE DATABASE_DEFAULT AS pid,
    NULLIF(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(4000), x.[FullName]))), N''), N'NULL') COLLATE DATABASE_DEFAULT AS fn,
    NULLIF(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(255), x.[Receipt_No]))), N''), N'NULL') COLLATE DATABASE_DEFAULT AS rn,
    COALESCE(CONVERT(NVARCHAR(20), TRY_CONVERT(BIGINT, x.[Mobile])), NULLIF(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(50), x.[Mobile]))), N''), N'NULL') COLLATE DATABASE_DEFAULT) COLLATE DATABASE_DEFAULT AS mob
  FROM dbo.income x WITH (NOLOCK)
),
p AS (
  SELECT a.id AS id_income2, b.id AS id_income,
    CASE WHEN EXISTS (SELECT a.d INTERSECT SELECT b.d) THEN 0 ELSE 1 END AS diff_d,
    CASE WHEN EXISTS (SELECT a.it INTERSECT SELECT b.it) THEN 0 ELSE 1 END AS diff_it,
    CASE WHEN EXISTS (SELECT a.dt INTERSECT SELECT b.dt) THEN 0 ELSE 1 END AS diff_dt,
    CASE WHEN EXISTS (SELECT a.rc INTERSECT SELECT b.rc) THEN 0 ELSE 1 END AS diff_rc,
    CASE WHEN EXISTS (SELECT a.loc INTERSECT SELECT b.loc) THEN 0 ELSE 1 END AS diff_loc,
    CASE WHEN EXISTS (SELECT a.pid INTERSECT SELECT b.pid) THEN 0 ELSE 1 END AS diff_pid,
    CASE WHEN EXISTS (SELECT a.fn INTERSECT SELECT b.fn) THEN 0 ELSE 1 END AS diff_fn,
    CASE WHEN EXISTS (SELECT a.rn INTERSECT SELECT b.rn) THEN 0 ELSE 1 END AS diff_rn,
    CASE WHEN EXISTS (SELECT a.mob INTERSECT SELECT b.mob) THEN 0 ELSE 1 END AS diff_mob,
    a.d AS a_d, b.d AS b_d,
    a.it AS a_it, b.it AS b_it,
    a.dt AS a_dt, b.dt AS b_dt,
    a.rc AS a_rc, b.rc AS b_rc,
    a.loc AS a_loc, b.loc AS b_loc,
    a.pid AS a_pid, b.pid AS b_pid,
    a.fn AS a_fn, b.fn AS b_fn,
    a.rn AS a_rn, b.rn AS b_rn,
    a.mob AS a_mob, b.mob AS b_mob
  FROM a JOIN b ON b.k = a.k
)
SELECT * INTO #pairs FROM p;

-- 1) สรุป: กี่คู่ที่ต่างกัน และต่างที่คอลัมน์ไหน
SELECT COUNT(*) AS pairs,
       SUM(CASE WHEN diff_d + diff_it + diff_dt + diff_rc + diff_loc + diff_pid + diff_fn + diff_rn > 0 THEN 1 ELSE 0 END) AS pairs_differ,
       SUM(diff_d) AS diff_d,
       SUM(diff_it) AS diff_it,
       SUM(diff_dt) AS diff_dt,
       SUM(diff_rc) AS diff_rc,
       SUM(diff_loc) AS diff_loc,
       SUM(diff_pid) AS diff_pid,
       SUM(diff_fn) AS diff_fn,
       SUM(diff_rn) AS diff_rn,
       SUM(diff_mob) AS diff_mobile_not_used
FROM #pairs;

-- 2) ตัวอย่างคู่ที่ต่างกัน 50 คู่
SELECT TOP 50 *
FROM #pairs
WHERE diff_d + diff_it + diff_dt + diff_rc + diff_loc + diff_pid + diff_fn + diff_rn > 0
ORDER BY id_income2;

-- 3) แถว income2 ที่ไม่มีคู่ใน income (คาดว่า 1 แถว ยอด 100)
SELECT i2.*
FROM dbo.income2 i2 WITH (NOLOCK)
WHERE NOT EXISTS (SELECT 1 FROM dbo.income i WITH (NOLOCK)
                  WHERE TRY_CONVERT(BIGINT, i.Income_ID) = TRY_CONVERT(BIGINT, i2.Income_ID) + 364480);

DROP TABLE #pairs;
