/**
 * ระดับข้อความบนจอตอน migrate — quiet (ดีฟอลต์) | normal | debug
 *
 * quiet = เหลือเฉพาะที่ต้องอ่านจริงตอนรัน
 *   - จำนวนที่จะ migrate ของตารางนั้น (`plan: ... rows`)
 *   - แถบ progress (rows/total + ETA) — เขียนผ่าน renderProgress ไม่ถูกกรอง
 *   - สรุปตอนจบตาราง (`done, ...` / `อ่านครบต้นทาง: ...`)
 *   - คำเตือน / หมายเหตุ / error / field issue log
 * ที่เหลือ (config profile, source/target, keyset, ensure DDL, chunk ทีละก้อน ฯลฯ) ซ่อนไว้
 * — ดูย้อนหลังได้จาก log JSON ของแต่ละตารางใน <ตาราง>/js-migrate/logs/
 *
 * ส่วน "ถึงตารางไหนแล้ว" มาจาก run-migrate-all.ps1 ([START]/[OK] [n/17] <ตาราง>)
 *
 * เปลี่ยนระดับ: env MIGRATE_LOG_LEVEL=normal|debug หรือ run-migrate-all.ps1 -LogLevel normal
 */

export const MIGRATE_LOG_LEVELS = ["quiet", "normal", "debug"];
export const DEFAULT_MIGRATE_LOG_LEVEL = "quiet";

/** @param {NodeJS.ProcessEnv} [env] */
export function resolveMigrateLogLevel(env = process.env) {
  const raw = String(env?.MIGRATE_LOG_LEVEL ?? "").trim().toLowerCase();
  return MIGRATE_LOG_LEVELS.includes(raw) ? raw : DEFAULT_MIGRATE_LOG_LEVEL;
}

/** บรรทัดรายละเอียดของ migrate — `>>> ...` (ขั้นตอน) และ `... ...` (ทีละ chunk) */
const DETAIL_LINE = /^\s*(>>>|\.\.\.)\s/;

/** รายละเอียดที่ยังต้องเห็นแม้อยู่โหมด quiet */
const KEEP_IN_QUIET =
  /(\]\s*(done[,:]|plan[\s:])|คำเตือน|หมายเหตุ:|อ่านครบต้นทาง|total rows read|field issue log:|FAILED|ล้มเหลว|ยังขาด|ไม่สำเร็จ)/;

/**
 * @param {unknown} msg บรรทัดแรกของข้อความที่จะพิมพ์
 * @param {string} [level]
 */
export function shouldPrintMigrateLine(msg, level = resolveMigrateLogLevel()) {
  if (level !== "quiet") return true;
  const text = String(msg ?? "");
  if (!DETAIL_LINE.test(text)) return true; // error / stack / marker ของสคริปต์อื่น
  return KEEP_IN_QUIET.test(text);
}

let installed = false;

/**
 * กรอง console.log / console.error ของ process นี้ตามระดับ log
 * (progressUi.mjs เรียกให้ตอนโหลด — ทุก entry ของ migrate import ไฟล์นั้นอยู่แล้ว)
 */
export function installMigrateLogFilter(level = resolveMigrateLogLevel()) {
  if (installed) return level;
  installed = true;
  silenceKnownNodeWarnings(level);
  if (level !== "quiet") return level;

  for (const name of /** @type {const} */ (["log", "error"])) {
    const original = console[name].bind(console);
    console[name] = (...args) => {
      if (args.length > 0 && !shouldPrintMigrateLine(args[0], level)) return;
      original(...args);
    };
  }
  return level;
}

/**
 * DeprecationWarning ของ tedious ตอนต่อ MSSQL ด้วย IP ("Setting the TLS ServerName
 * to an IP address is not permitted by RFC 6066") ขึ้นทุก process ครั้งละ 2 บรรทัด
 * — ซ่อนไว้ ยกเว้นระดับ debug; warning อื่นยังพิมพ์ตามเดิม
 */
export function silenceKnownNodeWarnings(level = resolveMigrateLogLevel()) {
  if (level === "debug") return;
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (
      warning?.name === "DeprecationWarning" &&
      /TLS ServerName/i.test(String(warning.message))
    ) {
      return;
    }
    console.error(`${warning.name}: ${warning.message}`);
  });
}
