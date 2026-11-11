/**
 * dbo.income + dbo.income2 — รายรับของศูนย์ (บริจาค / Copy CD) → public.center_income ตารางเดียว
 *
 * สองตารางคอลัมน์ชื่อชุดเดียวกัน: Income_ID, Income_date, Income_type, Donate_type, PID, FullName,
 *   Receipt, Receipt_No, Mobile, MobileUpdated, Mobile_Loc, Location_ID
 * แต่ชนิดคอลัมน์ไม่จำเป็นต้องตรงกัน (เช่น ตารางหนึ่งเป็น int อีกตารางเป็น nvarchar ที่เก็บคำว่า 'NULL' เป็นตัวอักษร)
 * — ห้ามเทียบ / UNION คอลัมน์ดิบข้ามตาราง ไม่งั้น SQL Server แปลง 'NULL' เป็น int แล้วพัง (error 245)
 * จึงแปลงทุกคอลัมน์ของแต่ละตารางเป็นข้อความรูปแบบเดียวกันก่อน (CTE n1 / n2) แล้วค่อยรวมแถว
 *
 * income2 ทั้งตารางถูกก๊อปไปไว้ใน income โดย Income_ID ใหม่ = Income_ID เดิม + 364480
 * (ตรวจ 2026-11-11: income2 38,970 แถว มีคู่ใน income 38,969 แถว เหลือแถวเดียวที่ไม่มีคู่)
 * ย้ายทั้งสองตารางตรงๆ ยอดจะซ้ำ — จึงตัดแถว income2 ที่ income มี Income_ID คู่ทิ้ง เก็บแถวของ income
 * (ตารางที่ใช้งานอยู่ ข้อมูลที่แก้ทีหลังอยู่ฝั่งนี้) ส่วนแถว income2 ที่ไม่มีคู่ย้ายตามปกติ
 * ไม่ตัดซ้ำด้วยการเทียบข้อมูลทุกช่อง: คู่ก๊อป ~1,975 คู่ถูกแก้ข้อมูลใน income ทีหลัง เทียบแล้วไม่ตรง
 * ทำให้ย้ายทั้งสองแถว (นับซ้ำ) — รอบแรก 11-10 ได้ 43,797 แทน 41,822
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

/** แถว income2 ID n ถูกก๊อปไปเป็นแถว income ID n + ค่านี้ */
export const CENTER_INCOME_ARCHIVE_COPY_ID_OFFSET = 364480;

/**
 * ข้อความหลัง trim — ค่าว่าง และคำว่า NULL ที่เก็บเป็นตัวอักษร = NULL จริง
 * @param {string} expr นิพจน์ NVARCHAR
 */
function cleanText(expr) {
  const t = `LTRIM(RTRIM(${expr}))`;
  return `(CASE WHEN UPPER(${t}) IN (N'', N'NULL') THEN NULL ELSE ${t} END)`;
}

/**
 * คอลัมน์ของตารางหนึ่ง แปลงเป็น NVARCHAR รูปแบบเดียวกันทั้งสองตาราง (ชนิดต้นทางต่างกันได้)
 * collation ของฐานข้อมูลทั้งหมด — UNION ALL ข้ามตารางที่ collation ต่างกันไม่ได้
 * @param {string} alias
 * @param {string} tableLiteral ชื่อตารางในคีย์
 * @param {number} rank ลำดับตารางตอนอ่าน
 */
function normalizedColumns(alias, tableLiteral, rank) {
  const c = (name) => `${alias}.[${name}]`;
  const db = "COLLATE DATABASE_DEFAULT";
  const text = (name, len) =>
    `${cleanText(`CONVERT(NVARCHAR(${len}), ${c(name)})`)} ${db}`;
  /** ตัวเลขจำนวนเต็ม (int / bit / ข้อความตัวเลข) → "1"; ข้อความที่ไม่ใช่ตัวเลขส่งต่อไปให้ field issue */
  const intText = (name) =>
    `COALESCE(CONVERT(NVARCHAR(20), TRY_CONVERT(BIGINT, ${c(name)})), ${cleanText(`CONVERT(NVARCHAR(50), ${c(name)})`)}) ${db}`;
  return `
    ${rank} AS src_rank,
    TRY_CONVERT(BIGINT, ${c("Income_ID")}) AS src_id,
    N'${tableLiteral}:' + LTRIM(RTRIM(CONVERT(NVARCHAR(20), ${c("Income_ID")}))) ${db} AS old_db_id,
    ${cleanText(`CONVERT(NVARCHAR(30), ${c("Income_date")}, 121)`)} ${db} AS income_date,
    ${intText("Income_type")} AS income_type,
    ${intText("Donate_type")} AS donate_type,
    ${text("PID", 255)} AS pid,
    ${text("FullName", 4000)} AS full_name,
    COALESCE(
      CONVERT(NVARCHAR(100), TRY_CONVERT(DECIMAL(19, 4), ${c("Receipt")})),
      ${cleanText(`CONVERT(NVARCHAR(100), ${c("Receipt")})`)}
    ) ${db} AS receipt,
    ${text("Receipt_No", 255)} AS receipt_no,
    ${intText("Mobile")} AS mobile,
    ${intText("Location_ID")} AS location_id`.trim();
}

/** คอลัมน์ของ CTE n1 / n2 / src ตามลำดับ normalizedColumns() */
const SRC_COLUMNS = [
  "src_rank",
  "src_id",
  "old_db_id",
  "income_date",
  "income_type",
  "donate_type",
  "pid",
  "full_name",
  "receipt",
  "receipt_no",
  "mobile",
  "location_id",
];

/**
 * ชุดแถวต้นทางทั้งหมด (income2 ที่ไม่มีคู่ก๊อปใน income + income ทุกแถว) เป็น CTE ชื่อ src
 * @param {string} schema
 */
function sourceCte(schema) {
  const s = `[${String(schema).replace(/]/g, "]]")}]`;
  const { main, archive } = CENTER_INCOME_SOURCE_TABLES;
  const list = (alias, cols) => cols.map((col) => `${alias}.${col}`).join(", ");
  return `
WITH n2 AS (
  SELECT
    ${normalizedColumns("x", archive, 1)}
  FROM ${s}.[${archive}] x WITH (NOLOCK)
),
n1 AS (
  SELECT
    ${normalizedColumns("x", main, 2)}
  FROM ${s}.[${main}] x WITH (NOLOCK)
),
src AS (
  SELECT ${list("a", SRC_COLUMNS)}
  FROM n2 a
  WHERE NOT EXISTS (
    SELECT 1
    FROM n1 b
    WHERE b.src_id = a.src_id + ${CENTER_INCOME_ARCHIVE_COPY_ID_OFFSET}
  )
  UNION ALL
  SELECT ${list("b", SRC_COLUMNS)}
  FROM n1 b
)`.trim();
}

const OUTPUT_COLUMNS = `
  old_db_id, income_date, income_type, donate_type, pid, full_name,
  receipt, receipt_no, mobile, location_id`.trim();

/** old_db_id ต่อท้ายกันลำดับไม่แน่นอน ถ้า Income_ID แปลงเป็นเลขไม่ได้ */
const ORDER_BY = "src_rank ASC, src_id ASC, old_db_id ASC";

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

/** repair-from-log / --source-ids: ดึงตามคีย์ "income:ID" / "income2:ID" (แถว income2 ที่มีคู่ก๊อปใน income จะไม่ออกมา) */
export function buildCenterIncomeByKeysSql(schema) {
  return `
${sourceCte(schema)}
SELECT ${OUTPUT_COLUMNS}
FROM src
WHERE old_db_id IN ({{idPlaceholders}})
ORDER BY ${ORDER_BY};
`.trim();
}

/** จำนวนแถวที่ migrate จะอ่านจริง (หลังตัด income2 ที่มีคู่ก๊อป) — ใช้ทำแผน + snapshot count ของ migrate:all */
export function buildCenterIncomeCountSql(schema) {
  return `
${sourceCte(schema)}
SELECT COUNT_BIG(1) AS total FROM src;
`.trim();
}

/** แยกจำนวน: income / income2 ทั้งหมด / income2 ที่เหลือหลังตัดแถวที่มีคู่ก๊อป — log ตอนเริ่ม job */
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
