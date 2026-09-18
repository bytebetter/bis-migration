/**
 * ที่คั่นหน้า keyset ของ appointment_reschedules (LogTime, Schedule_ID, Schedule_Datetime, ModifiedDate,
 * Old_Schedule_Datetime, %%physloc%%) — วันที่เก็บเป็นข้อความ style 121 ความละเอียดเต็ม DATETIME2(7)
 *
 * ไม่ import mssql: ให้ผู้เรียกส่ง sqlLib ของตัวเอง (คนละ instance → EPARAM)
 */
import {
  MSSQL_RESCHEDULE_ANCHOR_BY_PHYSLOC_SELECT,
  RESCHEDULE_KEYSET_ANCHOR_FORMAT,
} from "./mssqlAppointmentReschedulesSelect.mjs";

const TABLE_LABEL = "appointment_reschedules";

const RESCHEDULE_KEYSET_SENTINEL_SCHEDULE_ID_MIN = -9223372036854775808n;

/** ที่คั่นหน้าวันที่ = ข้อความ style 121 ของ DATETIME2(7) (ตรงกับ anchor ใน query keyset) */
const RESCHEDULE_ANCHOR_TEXT_RE =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{7}$/;

/**
 * จุดเริ่ม keyset ASC: cursor exclusive ด้านล่าง (เก่ากว่าทุกแถว)
 * ใช้ปี 1000 ให้ต่ำกว่า COALESCE floor 1753-01-01 ในคิวรี → `> floor` ครอบทุกแถว (รวมแถว LogTime NULL)
 */
const RESCHEDULE_KEYSET_FLOOR_TEXT = "1000-01-01 00:00:00.0000000";

const DATE_KEYS = [
  "logTime",
  "scheduleDatetime",
  "modifiedDate",
  "oldScheduleDatetime",
];

export function getRescheduleRowField(row, key) {
  return row[key] ?? row[key.toLowerCase()] ?? row[key.toUpperCase()];
}

function rescheduleAnchorText(raw) {
  const s = raw == null ? "" : String(raw).trim();
  if (!RESCHEDULE_ANCHOR_TEXT_RE.test(s)) {
    throw new Error(
      `[${TABLE_LABEL}] ที่คั่นหน้าวันที่ผิดรูปแบบ (ต้องเป็น style 121 เต็ม 7 หลัก): ${JSON.stringify(raw)}`,
    );
  }
  return s;
}

/**
 * checkpoint รุ่นก่อน: วันที่มาจาก JS Date (driver useUTC) เขียนด้วยเวลาเครื่อง ละเอียดแค่ ms
 * → พาร์สกลับด้วยเวลาเครื่องแล้วอ่านส่วนประกอบ UTC = ค่าในฐาน (ตัดเหลือ ms)
 */
export function legacyRescheduleAnchorToText(raw) {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?$/.exec(
      String(raw ?? "").trim(),
    );
  if (!m) return null;
  const ms = Number(String(m[7] ?? "0").padEnd(3, "0").slice(0, 3));
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
    ms,
  );
  if (Number.isNaN(d.getTime())) return null;
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}0000`;
}

/** ms ของข้อความ style 121 (ไว้เทียบค่าเดิมที่ละเอียดแค่ ms) */
export function rescheduleAnchorEpochMs(text) {
  return Date.parse(`${String(text).slice(0, 23).replace(" ", "T")}Z`);
}

/** %%physloc%% floor = 8 ไบต์ศูนย์ (physloc จริง file:page:slot ไม่มีทางเป็นศูนย์ทั้งหมด → `> floor` ครอบทุกแถว) */
function reschedulePhyslocFloor() {
  return Buffer.alloc(8);
}

/** คืน Buffer(8) จาก physloc ที่อาจเป็น Buffer (จาก driver) หรือ hex string (จาก checkpoint) หรือ null */
function normalizeReschedulePhysloc(raw) {
  if (raw == null) return reschedulePhyslocFloor();
  if (Buffer.isBuffer(raw)) {
    if (raw.length === 8) return raw;
    const b = Buffer.alloc(8);
    raw.copy(b, 0, 0, Math.min(8, raw.length));
    return b;
  }
  const s = String(raw)
    .trim()
    .replace(/^0x/i, "");
  if (/^[0-9a-fA-F]{1,16}$/.test(s)) {
    return Buffer.from(s.padStart(16, "0").slice(-16), "hex");
  }
  return reschedulePhyslocFloor();
}

function normalizeScheduleIdForKeyset(raw) {
  if (raw == null || String(raw).trim() === "") {
    return RESCHEDULE_KEYSET_SENTINEL_SCHEDULE_ID_MIN.toString();
  }
  try {
    return BigInt(String(raw).trim()).toString();
  } catch {
    return RESCHEDULE_KEYSET_SENTINEL_SCHEDULE_ID_MIN.toString();
  }
}

export function defaultRescheduleKeysetAfter() {
  return {
    logTime: RESCHEDULE_KEYSET_FLOOR_TEXT,
    scheduleId: RESCHEDULE_KEYSET_SENTINEL_SCHEDULE_ID_MIN.toString(),
    scheduleDatetime: RESCHEDULE_KEYSET_FLOOR_TEXT,
    modifiedDate: RESCHEDULE_KEYSET_FLOOR_TEXT,
    oldScheduleDatetime: RESCHEDULE_KEYSET_FLOOR_TEXT,
    physloc: reschedulePhyslocFloor(),
  };
}

/** checkpoint ที่ยังเป็นวันที่รุ่นเก่า (ไม่มี anchorFormat) — ต้องแปลงก่อนใช้ */
export function isLegacyRescheduleKeyset(raw) {
  return (
    raw != null &&
    typeof raw === "object" &&
    raw.anchorFormat !== RESCHEDULE_KEYSET_ANCHOR_FORMAT
  );
}

export function normalizeRescheduleKeysetAfter(raw) {
  if (!raw || typeof raw !== "object") return defaultRescheduleKeysetAfter();
  return {
    logTime: rescheduleAnchorText(raw.logTime),
    scheduleId: normalizeScheduleIdForKeyset(raw.scheduleId),
    scheduleDatetime: rescheduleAnchorText(raw.scheduleDatetime),
    modifiedDate: rescheduleAnchorText(raw.modifiedDate),
    oldScheduleDatetime: rescheduleAnchorText(raw.oldScheduleDatetime),
    physloc: normalizeReschedulePhysloc(raw.physloc),
  };
}

/** ที่คั่นหน้าจากแถว keyset (anchor ktv_* เป็นข้อความ style 121 จาก SQL) */
export function keysetAfterFromRescheduleRow(row) {
  return {
    logTime: rescheduleAnchorText(getRescheduleRowField(row, "ktv_log_time_ord")),
    scheduleId: normalizeScheduleIdForKeyset(
      getRescheduleRowField(row, "ktv_schedule_id_ord"),
    ),
    scheduleDatetime: rescheduleAnchorText(
      getRescheduleRowField(row, "ktv_schedule_dt_ord"),
    ),
    modifiedDate: rescheduleAnchorText(
      getRescheduleRowField(row, "ktv_modified_ord"),
    ),
    oldScheduleDatetime: rescheduleAnchorText(
      getRescheduleRowField(row, "ktv_old_schedule_dt_ord"),
    ),
    physloc: normalizeReschedulePhysloc(
      getRescheduleRowField(row, "ktv_physloc"),
    ),
  };
}

/**
 * checkpoint รุ่นก่อน → ความละเอียดเต็ม: หาแถวที่คั่นหน้าด้วย %%physloc%% ที่เก็บไว้
 * หาไม่เจอ/ไม่ตรง → ใช้ค่าละเอียด ms (แถวสุดท้ายของรอบก่อนอาจถูกอ่านซ้ำ)
 * @param {() => import("mssql").Request} newRequest
 * @param {typeof import("mssql")} sqlLib
 * @param {string} sourceRef
 * @param {Record<string, unknown>} legacyRaw
 * @returns {Promise<{ keyset: ReturnType<typeof defaultRescheduleKeysetAfter>, exact: boolean }>}
 */
export async function upgradeLegacyRescheduleKeyset(
  newRequest,
  sqlLib,
  sourceRef,
  legacyRaw,
) {
  const legacy = {
    logTime: legacyRescheduleAnchorToText(legacyRaw.logTime),
    scheduleId: normalizeScheduleIdForKeyset(legacyRaw.scheduleId),
    scheduleDatetime: legacyRescheduleAnchorToText(legacyRaw.scheduleDatetime),
    modifiedDate: legacyRescheduleAnchorToText(legacyRaw.modifiedDate),
    oldScheduleDatetime:
      legacyRaw.oldScheduleDatetime == null
        ? RESCHEDULE_KEYSET_FLOOR_TEXT
        : legacyRescheduleAnchorToText(legacyRaw.oldScheduleDatetime),
    physloc: normalizeReschedulePhysloc(legacyRaw.physloc),
  };
  if (DATE_KEYS.some((k) => legacy[k] == null)) {
    throw new Error(
      `[${TABLE_LABEL}] แปลง checkpoint รุ่นเก่าไม่ได้ (${JSON.stringify(legacyRaw)}) — ลบ checkpoints/ แล้ว TRUNCATE ปลายทาง รัน overwrite`,
    );
  }
  const res = await newRequest()
    .input("physloc", sqlLib.Binary(8), legacy.physloc)
    .query(
      MSSQL_RESCHEDULE_ANCHOR_BY_PHYSLOC_SELECT.replaceAll(
        "{{sourceObject}}",
        sourceRef,
      ),
    );
  const found = res.recordset || [];
  if (found.length === 1) {
    const exact = keysetAfterFromRescheduleRow(found[0]);
    const withinMs = (k) =>
      Math.abs(
        rescheduleAnchorEpochMs(exact[k]) - rescheduleAnchorEpochMs(legacy[k]),
      ) <= 1;
    if (exact.scheduleId === legacy.scheduleId && DATE_KEYS.every(withinMs)) {
      return { keyset: exact, exact: true };
    }
  }
  return { keyset: legacy, exact: false };
}

export function keysetAfterForPersist(k) {
  const n = normalizeRescheduleKeysetAfter(k);
  return {
    anchorFormat: RESCHEDULE_KEYSET_ANCHOR_FORMAT,
    logTime: n.logTime,
    scheduleDatetime: n.scheduleDatetime,
    modifiedDate: n.modifiedDate,
    oldScheduleDatetime: n.oldScheduleDatetime,
    scheduleId: String(n.scheduleId),
    physloc: normalizeReschedulePhysloc(n.physloc).toString("hex"),
  };
}

/**
 * วันที่ส่งเป็นข้อความ style 121 — predicate CAST เป็น DATETIME2(7) เอง (ไม่ผ่าน JS Date ที่เหลือแค่ ms)
 * @param {import("mssql").Request} req
 * @param {typeof import("mssql")} sqlLib
 */
export function bindRescheduleKeysetInputs(req, sqlLib, keysetAfter) {
  const k = normalizeRescheduleKeysetAfter(keysetAfter);
  req.input("afterLogTime", sqlLib.VarChar(27), k.logTime);
  req.input(
    "afterScheduleId",
    sqlLib.BigInt,
    BigInt(String(k.scheduleId).trim()),
  );
  req.input("afterScheduleDatetime", sqlLib.VarChar(27), k.scheduleDatetime);
  req.input("afterModifiedDate", sqlLib.VarChar(27), k.modifiedDate);
  req.input(
    "afterOldScheduleDatetime",
    sqlLib.VarChar(27),
    k.oldScheduleDatetime,
  );
  req.input(
    "afterPhysloc",
    sqlLib.Binary(8),
    normalizeReschedulePhysloc(k.physloc),
  );
}
