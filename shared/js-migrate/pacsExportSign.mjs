/**
 * Sign to PACs (state = '3') — ตัดสินจาก dbo.PACS_EXPORT_PDF ฝั่ง MSSQL
 *
 * report ที่ sync ขึ้น PACS แล้ว (Is_LatestRPT_Synced = 1) ให้ยก state เป็น Sign to PACs
 *   RPT_TYPE = 2           -> report ของ mammogram / ultrasound (state '3')
 *   RPT_TYPE อื่น (รวม NULL) -> report ของ procedure (ต้นทางคือ dbo.biopsy, state '2')
 * นอกนั้น (Is_LatestRPT_Synced = 0 หรือไม่มีแถวใน PACS_EXPORT_PDF) คง state = '1' (Report)
 *
 * choices ฝั่ง Directus ไม่เหมือนกันทั้ง 3 ตาราง — ค่า Sign to PACs ต่างกัน:
 *   mammogram / ultrasound : 0=Draft, 1=Report, 2=undefined, 3=Sign to PACs
 *   procedure              : 0=Draft, 1=Report, 2=Sign to PACS (ไม่มีค่า 3)
 */
import sql from "mssql";

/** RPT_TYPE ของ report ฝั่ง mammogram / ultrasound */
export const PACS_RPT_TYPE_MAM_US = 2;

/** SQL Server จำกัด parameter ต่อ request — ล้อจำนวนเดียวกับ fetchMamChildCountsByExamIds */
const EXAM_IDS_PER_REQUEST = 500;

function bracketIdent(value) {
  return `[${String(value).replace(/]/g, "]]")}]`;
}

/**
 * ชื่อตาราง PACS_EXPORT_PDF ฝั่งต้นทาง (override ได้ที่ config.source.pacsExportTable)
 * @param {{ schema?: string, pacsExportTable?: string } | null | undefined} source
 */
export function pacsExportTableNoLock(source) {
  const schema = source?.schema ?? "dbo";
  const table = source?.pacsExportTable ?? "PACS_EXPORT_PDF";
  return `${bracketIdent(schema)}.${bracketIdent(table)} WITH (NOLOCK)`;
}

/**
 * Exam_ID ที่ควรได้ state = '3' (Sign to PACs) ของ chunk นี้
 *
 * @param {import("mssql").ConnectionPool} mssqlPool
 * @param {{ pacsTableNoLock: string, rptTypeMode: "mam_us" | "procedure" }} options
 * @param {Array<string | number>} examIds
 * @returns {Promise<Set<number>>}
 */
export async function fetchPacsSignedExamIds(
  mssqlPool,
  { pacsTableNoLock, rptTypeMode },
  examIds,
) {
  const signed = new Set();
  const uniq = [
    ...new Set(
      (examIds ?? [])
        .map((x) => Number.parseInt(String(x), 10))
        .filter((x) => Number.isFinite(x)),
    ),
  ];
  if (uniq.length === 0) return signed;

  // RPT_TYPE / Is_LatestRPT_Synced ฝั่งต้นทางอาจเป็น varchar — TRY_CAST กันคิวรีพังเพราะ implicit convert
  const rptTypeWhere =
    rptTypeMode === "procedure"
      ? `(TRY_CAST([RPT_TYPE] AS INT) IS NULL OR TRY_CAST([RPT_TYPE] AS INT) <> ${PACS_RPT_TYPE_MAM_US})`
      : `TRY_CAST([RPT_TYPE] AS INT) = ${PACS_RPT_TYPE_MAM_US}`;

  for (let i = 0; i < uniq.length; i += EXAM_IDS_PER_REQUEST) {
    const batch = uniq.slice(i, i + EXAM_IDS_PER_REQUEST);
    if (batch.length === 0) continue;
    const placeholders = batch.map((_, idx) => `@e${idx}`).join(", ");
    const req = mssqlPool.request();
    batch.forEach((id, idx) => req.input(`e${idx}`, sql.BigInt, id));
    const res = await req.query(
      `SELECT DISTINCT CAST([Exam_ID] AS BIGINT) AS exam_id
       FROM ${pacsTableNoLock}
       WHERE [Exam_ID] IN (${placeholders})
         AND TRY_CAST([Is_LatestRPT_Synced] AS INT) = 1
         AND ${rptTypeWhere}`,
    );
    for (const row of res.recordset ?? []) {
      signed.add(Number(row.exam_id));
    }
  }
  return signed;
}

/** ค่าที่เก็บลงคอลัมน์ pacs_signed ของ staging ('1' = Sign to PACs) */
export function pacsSignedFlag(signedExamIds, examId) {
  const n = Number.parseInt(String(examId), 10);
  return Number.isFinite(n) && signedExamIds.has(n) ? "1" : "0";
}
