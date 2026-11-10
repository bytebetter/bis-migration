/**
 * dbo.income + dbo.income2 — รายรับของศูนย์ (บริจาค / Copy CD) → public.center_income ตารางเดียว
 *
 * สองตารางคอลัมน์ชุดเดียวกัน: Income_ID, Income_date, Income_type, Donate_type, PID, FullName,
 *   Receipt, Receipt_No, Mobile, MobileUpdated, Mobile_Loc, Location_ID
 *
 * income มีแถวที่ก๊อปมาจาก income2 ทั้งแถว (Income_ID ใหม่) — ย้ายทั้งสองตารางตรงๆ ยอดจะซ้ำ
 * จึงตัดแถว income2 ที่มีแถวใน income ค่าเหมือนกันทุกช่องข้อมูล (วันที่ ประเภท PID ชื่อ ยอด เลขใบเสร็จ สถานที่)
 * ทิ้ง — เก็บแถวของ income (ตารางที่ใช้งานอยู่) ไว้ ส่วนแถวที่มีแค่ใน income2 ย้ายตามปกติ
 * ไม่เทียบ Mobile / MobileUpdated / Mobile_Loc (สถานะ sync หน่วยเคลื่อนที่ ไม่ใช่ข้อมูลรายรับ)
 *
 * คีย์ประจำแถว (= old_db_id ปลายทาง, ใช้ใน log / --source-ids / repair-from-log): "<ตาราง>:<Income_ID>"
 *   เช่น income:339323, income2:10 — Income_ID สองตารางนับแยกกัน เลขเดียวกันชนกันได้ จึงต้องมีชื่อตาราง
 *
 * ลำดับอ่าน: income2 ก่อน แล้วค่อย income (เรียง Income_ID) — แถวใหม่เข้า income ต่อท้ายลำดับเสมอ
 * OFFSET ของแถวที่อ่านไปแล้วไม่เลื่อน
 */

/** ชื่อตารางในคีย์ old_db_id — ต้องตรงกับ centerIncomeRowKey() ฝั่ง JS (ตัวเล็ก) */
export const CENTER_INCOME_SOURCE_TABLES = {
  main: "income",
  archive: "income2",
};

/** คอลัมน์ข้อมูลที่ใช้ตัดสินว่าแถว income2 ซ้ำกับ income (เทียบแบบ NULL = NULL ด้วย INTERSECT) */
const DEDUPE_TEXT_COLUMNS = ["PID", "FullName", "Receipt_No"];
const DEDUPE_OTHER_COLUMNS = ["Income_type", "Donate_type", "Receipt", "Location_ID"];

/**
 * @param {string} alias
 */
function dedupeSelectList(alias) {
  return [
    ...DEDUPE_OTHER_COLUMNS.map((c) => `${alias}.[${c}]`),
    // collation ต่างกันระหว่างตารางจะ INTERSECT ไม่ได้ — ใช้ของฐานข้อมูลทั้งสองฝั่ง
    // แปลงเป็น NVARCHAR ก่อน: COLLATE ใช้กับคอลัมน์ตัวเลขไม่ได้ (PID อาจเป็น int)
    ...DEDUPE_TEXT_COLUMNS.map(
      (c) => `CONVERT(NVARCHAR(4000), ${alias}.[${c}]) COLLATE DATABASE_DEFAULT`,
    ),
  ].join(", ");
}

/**
 * @param {string} alias
 * @param {string} tableLiteral ชื่อตารางในคีย์
 * @param {number} rank ลำดับตารางตอนอ่าน
 */
function selectColumns(alias, tableLiteral, rank) {
  return `
    ${rank} AS src_rank,
    ${alias}.[Income_ID] AS src_id,
    N'${tableLiteral}:' + CONVERT(NVARCHAR(20), ${alias}.[Income_ID]) AS old_db_id,
    CONVERT(NVARCHAR(30), ${alias}.[Income_date], 121) AS income_date,
    CONVERT(NVARCHAR(20), ${alias}.[Income_type]) AS income_type,
    CONVERT(NVARCHAR(20), ${alias}.[Donate_type]) AS donate_type,
    LTRIM(RTRIM(CONVERT(NVARCHAR(255), ${alias}.[PID]))) AS pid,
    CAST(${alias}.[FullName] AS NVARCHAR(MAX)) AS full_name,
    COALESCE(
      CONVERT(NVARCHAR(100), TRY_CONVERT(DECIMAL(19, 4), ${alias}.[Receipt])),
      CONVERT(NVARCHAR(100), ${alias}.[Receipt])
    ) AS receipt,
    LTRIM(RTRIM(CONVERT(NVARCHAR(255), ${alias}.[Receipt_No]))) AS receipt_no,
    CONVERT(NVARCHAR(10), ${alias}.[Mobile]) AS mobile,
    CONVERT(NVARCHAR(20), ${alias}.[Location_ID]) AS location_id`.trim();
}

/**
 * ชุดแถวต้นทางทั้งหมด (income2 ที่ไม่ซ้ำ + income) เป็น CTE ชื่อ src
 * @param {string} schema
 */
function sourceCte(schema) {
  const s = `[${String(schema).replace(/]/g, "]]")}]`;
  const { main, archive } = CENTER_INCOME_SOURCE_TABLES;
  return `
WITH src AS (
  SELECT
    ${selectColumns("i2", archive, 1)}
  FROM ${s}.[${archive}] i2 WITH (NOLOCK)
  WHERE NOT EXISTS (
    SELECT 1
    FROM ${s}.[${main}] i WITH (NOLOCK)
    WHERE ISNULL(i.[Income_date], '19000101') = ISNULL(i2.[Income_date], '19000101')
      AND EXISTS (SELECT ${dedupeSelectList("i")} INTERSECT SELECT ${dedupeSelectList("i2")})
  )
  UNION ALL
  SELECT
    ${selectColumns("i", main, 2)}
  FROM ${s}.[${main}] i WITH (NOLOCK)
)`.trim();
}

const OUTPUT_COLUMNS = `
  old_db_id, income_date, income_type, donate_type, pid, full_name,
  receipt, receipt_no, mobile, location_id`.trim();

const ORDER_BY = "src_rank ASC, src_id ASC";

/** หน้าถัดไปตามลำดับ — @offset/@page มาจาก sourceIndexRange ของ job (เดินครบทุกแถวทุกรอบ) */
export function buildCenterIncomePageSql(schema) {
  return `
${sourceCte(schema)}
SELECT ${OUTPUT_COLUMNS}
FROM src
ORDER BY ${ORDER_BY}
OFFSET @offset ROWS FETCH NEXT @page ROWS ONLY;
`.trim();
}

/** repair-from-log / --source-ids: ดึงตามคีย์ "income:ID" / "income2:ID" (แถว income2 ที่ซ้ำ income จะไม่ออกมา) */
export function buildCenterIncomeByKeysSql(schema) {
  return `
${sourceCte(schema)}
SELECT ${OUTPUT_COLUMNS}
FROM src
WHERE old_db_id IN ({{idPlaceholders}})
ORDER BY ${ORDER_BY};
`.trim();
}

/** จำนวนแถวที่ migrate จะอ่านจริง (หลังตัด income2 ที่ซ้ำ) — ใช้ทำแผน + snapshot count ของ migrate:all */
export function buildCenterIncomeCountSql(schema) {
  return `
${sourceCte(schema)}
SELECT COUNT_BIG(1) AS total FROM src;
`.trim();
}

/** แยกจำนวน: income / income2 ทั้งหมด / income2 ที่ตัดทิ้งเพราะซ้ำ — log ตอนเริ่ม job */
export function buildCenterIncomeBreakdownSql(schema) {
  const s = `[${String(schema).replace(/]/g, "]]")}]`;
  const { main, archive } = CENTER_INCOME_SOURCE_TABLES;
  return `
${sourceCte(schema)}
SELECT
  (SELECT COUNT_BIG(1) FROM ${s}.[${main}] WITH (NOLOCK)) AS main_total,
  (SELECT COUNT_BIG(1) FROM ${s}.[${archive}] WITH (NOLOCK)) AS archive_total,
  (SELECT COUNT_BIG(1) FROM src WHERE src_rank = 1) AS archive_kept;
`.trim();
}
