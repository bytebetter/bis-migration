/**
 * โหมด --count-only สำหรับ snapshot จำนวนแถวต้นทางก่อนรัน migrate:all
 *
 * แนวคิด: ตอนเริ่ม migrate:all จะเรียก migrate แต่ละตารางด้วย --count-only ก่อน
 * เพื่อ "freeze" จำนวนแถว ณ เวลานั้น แล้วส่งกลับเป็น --source-count-cap ต่อตาราง
 * (ไม่ใช้ --source-index-to เพราะจะเปลี่ยนชื่อไฟล์ checkpoint → resume ไม่ต่อ)
 * ทำให้ข้อมูลที่ไหลเข้ามาระหว่างรัน (key/วันที่ใหม่ → อยู่ท้าย ORDER BY) ไม่ถูกดึงเข้ามาแบบไม่สม่ำเสมอ
 *
 * ค่าที่นับใช้ logic เดิมของแต่ละตาราง (universe ตรงตาม WHERE/filter ของตารางนั้นเป๊ะ)
 */

/** บรรทัด sentinel ที่ orchestrator (PowerShell) จะ parse เอาตัวเลขออกมา */
export const SOURCE_COUNT_SENTINEL = "##SOURCE_COUNT##";

/**
 * เป็นรอบ --count-only หรือไม่ (อ่านจาก argv ตรงๆ — ไม่พึ่ง config var ของแต่ละไฟล์)
 * @param {string[]} [argv]
 */
export function isCountOnlyRun(argv = process.argv) {
  return argv.includes("--count-only");
}

/**
 * พิมพ์จำนวนแถวต้นทางออก stdout แล้วจบโปรเซสทันที (ไม่ทำ migrate)
 * @param {number | null | undefined} count
 */
export function emitSourceCountAndExit(count) {
  const n =
    count == null || !Number.isFinite(Number(count)) ? "null" : String(count);
  process.stdout.write(`${SOURCE_COUNT_SENTINEL} ${n}\n`);
  process.exit(0);
}

/**
 * ถ้าเป็นรอบ --count-only → พิมพ์ count แล้ว exit; ไม่ใช่ → ไม่ทำอะไร
 * เรียกหลังคำนวณ count เต็ม (ก่อนเริ่มลูป migrate จริง)
 * @param {number | null | undefined} count จำนวนแถว universe เต็ม (ก่อน narrow ตาม index)
 */
export function maybeEmitSourceCount(count) {
  if (isCountOnlyRun()) emitSourceCountAndExit(count);
}
