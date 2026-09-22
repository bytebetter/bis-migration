/**
 * dbo.MOBILE_LOCATION — ตาราง lookup เล็ก (ID, Name) 1 แถวต่อสถานที่ออกหน่วย
 *
 * probe ดึง [ID] เรียงตามเลขด้วย OFFSET/FETCH (ไม่ใช่ keyset) — ตารางมีไม่กี่ร้อยแถว
 * และเดินครบทุกแถวทุกรอบอยู่แล้ว การใช้ OFFSET ทำให้ --source-index-range ใช้ได้ตรงตัว
 * detail ดึงชื่อของ id ที่ probe ได้ (ชุดเดียวกับที่ repair-from-log / --source-ids ส่งมา)
 */
const OLD_ID_EXPR = "CAST([ID] AS BIGINT)";

/** หน้า [ID] ถัดไปตามลำดับ — @offset/@page มาจาก sourceIndexRange ของ job */
export const MSSQL_MOBILE_LOCATION_ID_SELECT = `
SELECT
  ${OLD_ID_EXPR} AS old_id
FROM {{sourceObject}}
WHERE [ID] IS NOT NULL
  AND (@migrateSrcKeyMin IS NULL OR ${OLD_ID_EXPR} >= @migrateSrcKeyMin)
  AND (@migrateSrcKeyMax IS NULL OR ${OLD_ID_EXPR} <= @migrateSrcKeyMax)
ORDER BY ${OLD_ID_EXPR} ASC
OFFSET @offset ROWS FETCH NEXT @page ROWS ONLY
`.trim();

export const MSSQL_MOBILE_LOCATION_DETAIL_BY_IDS_SELECT = `
SELECT
  CAST(${OLD_ID_EXPR} AS NVARCHAR(MAX)) AS old_id,
  CAST([Name] AS NVARCHAR(MAX)) AS name
FROM {{sourceObject}}
WHERE ${OLD_ID_EXPR} IN ({{idPlaceholders}})
ORDER BY ${OLD_ID_EXPR} ASC
`.trim();
