-- ตรวจความหมายคอลัมน์ dbo.billing (MSSQL ระบบเดิม) ก่อนตัดสินใจ map ข้อที่เหลือในสเปกการเงิน
-- อ่านอย่างเดียว — รันใน SSMS / sqlcmd บนเครื่องที่ต่อ MSSQL ได้ แล้วส่งผลกลับมา
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

-- 1) คอลัมน์ทั้งหมดของ dbo.billing — หาคอลัมน์เจ้าหน้าที่ (finance_case_owner / officer) ที่ migrate ยังไม่ได้ดึง
SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'billing'
ORDER BY ORDINAL_POSITION;

-- 2) A–H เก็บอะไร (จำนวน / flag / ชื่อรายการ) และราคาเท่าไหร่ — ระบบใหม่ถือ a=Mammogram(ภาพ) b=Spot c=Implant d=US e=แผ่น CD
SELECT 'A' AS col, CAST([A] AS NVARCHAR(100)) AS val, COUNT(*) AS n, MIN([A_Price]) AS min_price, MAX([A_Price]) AS max_price FROM dbo.billing GROUP BY CAST([A] AS NVARCHAR(100))
UNION ALL SELECT 'B', CAST([B] AS NVARCHAR(100)), COUNT(*), MIN([B_Price]), MAX([B_Price]) FROM dbo.billing GROUP BY CAST([B] AS NVARCHAR(100))
UNION ALL SELECT 'C', CAST([C] AS NVARCHAR(100)), COUNT(*), MIN([C_Price]), MAX([C_Price]) FROM dbo.billing GROUP BY CAST([C] AS NVARCHAR(100))
UNION ALL SELECT 'D', CAST([D] AS NVARCHAR(100)), COUNT(*), MIN([D_Price]), MAX([D_Price]) FROM dbo.billing GROUP BY CAST([D] AS NVARCHAR(100))
UNION ALL SELECT 'E', CAST([E] AS NVARCHAR(100)), COUNT(*), MIN([E_Price]), MAX([E_Price]) FROM dbo.billing GROUP BY CAST([E] AS NVARCHAR(100))
UNION ALL SELECT 'F', CAST([F] AS NVARCHAR(100)), COUNT(*), MIN([F_Price]), MAX([F_Price]) FROM dbo.billing GROUP BY CAST([F] AS NVARCHAR(100))
UNION ALL SELECT 'G', CAST([G] AS NVARCHAR(100)), COUNT(*), MIN([G_Price]), MAX([G_Price]) FROM dbo.billing GROUP BY CAST([G] AS NVARCHAR(100))
UNION ALL SELECT 'H', CAST([H] AS NVARCHAR(100)), COUNT(*), MIN([H_Price]), MAX([H_Price]) FROM dbo.billing GROUP BY CAST([H] AS NVARCHAR(100))
ORDER BY col, n DESC;

-- 3) Total กับ Receipt ต่างกันยังไง แยกตาม Patient_Type — Receipt คือยอดรับเงินจริงหรือไม่ (ถ้าใช่ → total / paid_amount)
SELECT
  [Patient_Type],
  COUNT(*) AS n,
  SUM(CASE WHEN [Receipt] IS NULL THEN 1 ELSE 0 END) AS receipt_null,
  SUM(CASE WHEN [Receipt] = [Total] THEN 1 ELSE 0 END) AS receipt_eq_total,
  SUM(CASE WHEN [Receipt] < [Total] THEN 1 ELSE 0 END) AS receipt_lt_total,
  SUM(CASE WHEN [Receipt] > [Total] THEN 1 ELSE 0 END) AS receipt_gt_total,
  SUM(CASE WHEN [Total] = 0 THEN 1 ELSE 0 END) AS total_zero,
  AVG(CAST([Total] AS DECIMAL(18, 2))) AS avg_total,
  AVG(CAST([Receipt] AS DECIMAL(18, 2))) AS avg_receipt,
  SUM(CASE WHEN NULLIF(LTRIM(RTRIM([Receipt_No])), '') IS NULL THEN 1 ELSE 0 END) AS no_receipt_no
FROM dbo.billing
GROUP BY [Patient_Type]
ORDER BY [Patient_Type];

-- 4) Total = ผลรวมราคารายการ + OPD หรือไม่ (ดูว่า Total รวม Copy CD / ค่าผู้ป่วยนอก ไว้แล้วหรือยัง)
SELECT TOP 30
  [Exam_ID], [Patient_Type], [Total], [Receipt], [Cash], [CanClaimExpense], [OPD], [OPD_Price], [Foreigner],
  [A], [A_Price], [B], [B_Price], [C], [C_Price], [D], [D_Price], [E], [E_Price], [H], [H_Price], [CopyFilmFilm],
  ISNULL([A_Price], 0) + ISNULL([B_Price], 0) + ISNULL([C_Price], 0) + ISNULL([D_Price], 0) + ISNULL([E_Price], 0)
    + ISNULL([F_Price], 0) + ISNULL([G_Price], 0) + ISNULL([H_Price], 0) + ISNULL([OPD_Price], 0) AS sum_a_h_opd
FROM dbo.billing
WHERE [Total] > 0
ORDER BY [Exam_ID] DESC;

-- 5) Cash / CanClaimExpense / CopyFilmFilm กระจายยังไง
SELECT 'Cash' AS col, CAST([Cash] AS NVARCHAR(50)) AS val, COUNT(*) AS n FROM dbo.billing GROUP BY CAST([Cash] AS NVARCHAR(50))
UNION ALL SELECT 'CanClaimExpense', CAST([CanClaimExpense] AS NVARCHAR(50)), COUNT(*) FROM dbo.billing GROUP BY CAST([CanClaimExpense] AS NVARCHAR(50))
UNION ALL SELECT 'CopyFilmFilm', CAST([CopyFilmFilm] AS NVARCHAR(50)), COUNT(*) FROM dbo.billing GROUP BY CAST([CopyFilmFilm] AS NVARCHAR(50))
ORDER BY col, n DESC;
