import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensurePlaceholderAppointment,
} from "../../shared/js-migrate/ensurePlaceholderAppointment.mjs";
import {
  ensurePlaceholderPatientInfo,
} from "../../shared/js-migrate/ensurePlaceholderPatientInfo.mjs";
import {
  ensureReferringMdByFullnames,
  referringMdMatchKey,
} from "../../shared/js-migrate/referringMdResolve.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * แมปแถว examination จาก MSSQL -> public.examination (เทียบ logic เดิมจาก SQL)
 */

const INT_RE = /^-?\d+$/;

/**
 * รองรับคีย์จาก JSON export (PascalCase เช่น Referring_MD) และจาก MSSQL driver (snake_case)
 */
export function getField(row, key) {
  if (row == null) return undefined;
  if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  const lk = key.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(row, lk)) return row[lk];
  const uk = key.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(row, uk)) return row[uk];
  for (const k of Object.keys(row)) {
    if (k.toLowerCase() === lk) return row[k];
  }
  return undefined;
}

export function normExamId(v) {
  if (v == null) return "";
  return String(v)
    .replace(/^\uFEFF/, "")
    .trim();
}

export function normPid(v) {
  if (v == null) return "";
  return String(v)
    .replace(/^\uFEFF/, "")
    .trim();
}

function nullIfTrimEmpty(v) {
  if (v == null) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
}

function isDigitsOnly(v) {
  return INT_RE.test(v);
}

function toStrictInt(v) {
  const t = nullIfTrimEmpty(v);
  if (t == null || !isDigitsOnly(t)) return null;
  return Number.parseInt(t, 10);
}

function toBool01(v) {
  const t = nullIfTrimEmpty(v);
  if (t == null) return null;
  if (["1", "true", "True", "Y", "y", "t", "T"].includes(t)) return true;
  if (["0", "false", "False", "N", "n", "f", "F"].includes(t)) return false;
  return null;
}

/**
 * เทียบกับ mssql_be_datetime_to_timestamp:
 * - รับรูป "YYYY-MM-DD..." จาก MSSQL
 * - ถ้าปีเป็น พ.ศ. (ช่วง 2400+) ให้ลบ 543 -> ค.ศ.
 * - ถ้าปีเป็น ค.ศ. อยู่แล้ว ให้คงเดิม
 * - ถ้าวันที่ไม่ valid (เช่น 29 ก.พ. ในปีไม่ leap) ให้คืน null
 * - คืนค่า "YYYY-MM-DD HH:mm:ss" หรือ null
 */
function toPgTimestamp(v) {
  const t = nullIfTrimEmpty(v);
  if (t == null || t.length < 10 || t[4] !== "-") return null;

  const y = Number.parseInt(t.slice(0, 4), 10);
  const m = t.slice(5, 7);
  const d = t.slice(8, 10);
  if (!Number.isFinite(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d))
    return null;

  const yyyy = y >= 2400 ? y - 543 : y;
  // Validate Gregorian date before formatting for PostgreSQL timestamp.
  const dt = new Date(
    Date.UTC(yyyy, Number.parseInt(m, 10) - 1, Number.parseInt(d, 10)),
  );
  if (
    Number.isNaN(dt.getTime()) ||
    dt.getUTCFullYear() !== yyyy ||
    dt.getUTCMonth() !== Number.parseInt(m, 10) - 1 ||
    dt.getUTCDate() !== Number.parseInt(d, 10)
  ) {
    return null;
  }
  const timeRaw = t.slice(10).trim();
  if (timeRaw === "") return `${yyyy}-${m}-${d} 00:00:00`;

  const timePart = timeRaw.replace("T", " ").replace("Z", "");
  const hh = timePart.slice(0, 2);
  const mi = timePart.slice(3, 5);
  const ss = timePart.slice(6, 8);
  if (!/^\d{2}$/.test(hh) || !/^\d{2}$/.test(mi) || !/^\d{2}$/.test(ss)) {
    return `${yyyy}-${m}-${d} 00:00:00`;
  }
  return `${yyyy}-${m}-${d} ${hh}:${mi}:${ss}`;
}

function toUnixEpochSeconds(v) {
  const ts = toPgTimestamp(v);
  if (ts == null) return null;
  const ms = Date.parse(`${ts.replace(" ", "T")}Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

/**
 * MobileUpdated จาก MSSQL:
 * - ค่าว่าง / CONVERT(...,126) ได้ "0" หรือ "1" = ไม่มีวันที่อัปเดต → null
 * - ตัวเลขล้วน = unix epoch ที่เก็บในต้นทาง
 * - รูปแบบวันที่ ISO = แปลงเป็น unix epoch
 */
function toMobileUpdatedEpoch(v) {
  const t = nullIfTrimEmpty(v);
  if (t == null || t === "0" || t === "1") return null;
  if (/^-?\d+$/.test(t)) {
    const n = Number.parseInt(t, 10);
    return Number.isFinite(n) ? n : null;
  }
  return toUnixEpochSeconds(v);
}

export function distinctOnNormExamId(mssqlRows) {
  const rowsSorted = [...mssqlRows].sort((a, b) => {
    const ai = toStrictInt(getField(a, "exam_id"));
    const bi = toStrictInt(getField(b, "exam_id"));
    if (ai == null && bi == null) return 0;
    if (ai == null) return 1;
    if (bi == null) return -1;
    return ai - bi;
  });
  const seen = new Map();
  for (const row of rowsSorted) {
    const nExamId = normExamId(getField(row, "exam_id"));
    if (nExamId === "") continue;
    if (!seen.has(nExamId)) seen.set(nExamId, row);
  }
  return Array.from(seen.values());
}

const INSERT_DEFS = [
  ["old_exam_id", "text", (row) => normExamId(getField(row, "exam_id"))],
  ["old_pid", "text", (row) => nullIfTrimEmpty(normPid(getField(row, "pid")))],
  ["patient", "int4", (_row, ctx) => ctx.patientId],
  [
    "exam_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "exam_date")),
  ],
  [
    "tech_login_name",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "tech_login_name")),
  ],
  ["mobile", "boolean", (row) => toBool01(getField(row, "mobile"))],
  [
    "mobile_update",
    "boolean",
    (row) => toBool01(getField(row, "mobile_update")),
  ],
  [
    "menstruation_age",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "menstruation_age")),
  ],
  [
    "menopause_age",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "menopause_age")),
  ],
  [
    "first_pregnancy_age",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "first_pregnancy_age")),
  ],
  [
    "num_pregnancy",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "num_pregnancy")),
  ],
  ["cont_use", "boolean", (row) => toBool01(getField(row, "cont_use"))],
  ["cont_yrs", "text", (row) => nullIfTrimEmpty(getField(row, "cont_yrs"))],
  ["hormone_use", "boolean", (row) => toBool01(getField(row, "hormone_use"))],
  [
    "hormone_yrs",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "hormone_yrs")),
  ],
  ["hysterectomy", "boolean", (row) => toBool01(getField(row, "hysterectomy"))],
  [
    "ovaries_removed",
    "boolean",
    (row) => toBool01(getField(row, "ovaries_removed")),
  ],
  ["pregnant", "boolean", (row) => toBool01(getField(row, "pragnant"))],
  ["referring_md", "int4", (row) => toStrictInt(getField(row, "referring_md"))],
  [
    "referring_hospital",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "referring_hospital")),
  ],
  [
    "prev_mammo_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "prev_mammo_date")),
  ],
  [
    "prev_mammo_loc",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "prev_mammo_loc")),
  ],
  [
    "sister_cancer_age",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "sister_cancer_age")),
  ],
  [
    "mother_cancer_age",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "mother_cancer_age")),
  ],
  [
    "grandmother_cancer_age",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "grandmother_cancer_age")),
  ],
  [
    "other_cancer_age",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "other_cancer_age")),
  ],
  [
    "biopsy_l_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "biopsy_l_date")),
  ],
  [
    "biopsy_r_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "biopsy_r_date")),
  ],
  [
    "chemo_l_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "chemo_l_date")),
  ],
  [
    "chemo_r_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "chemo_r_date")),
  ],
  [
    "cyst_l_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "cyst_l_date")),
  ],
  [
    "cyst_r_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "cyst_r_date")),
  ],
  [
    "irr_l_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "irr_l_date")),
  ],
  [
    "irr_r_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "irr_r_date")),
  ],
  [
    "lump_l_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "lump_l_date")),
  ],
  [
    "lump_r_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "lump_r_date")),
  ],
  [
    "mast_l_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "mast_l_date")),
  ],
  [
    "mast_r_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "mast_r_date")),
  ],
  [
    "rad_l_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "rad_l_date")),
  ],
  [
    "rad_r_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "rad_r_date")),
  ],
  [
    "num_left_mass",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "num_left_mass")),
  ],
  [
    "num_right_mass",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "num_right_mass")),
  ],
  ["lnwn", "boolean", (row) => toBool01(getField(row, "lnwn"))],
  ["lnww", "boolean", (row) => toBool01(getField(row, "lnww"))],
  ["ln", "boolean", (row) => toBool01(getField(row, "ln"))],
  ["lnen", "boolean", (row) => toBool01(getField(row, "lnen"))],
  ["lnee", "boolean", (row) => toBool01(getField(row, "lnee"))],
  ["le", "boolean", (row) => toBool01(getField(row, "le"))],
  ["lm", "boolean", (row) => toBool01(getField(row, "lm"))],
  ["lw", "boolean", (row) => toBool01(getField(row, "lw"))],
  ["lsws", "boolean", (row) => toBool01(getField(row, "lsws"))],
  ["lsww", "boolean", (row) => toBool01(getField(row, "lsww"))],
  ["ls", "boolean", (row) => toBool01(getField(row, "ls"))],
  ["lses", "boolean", (row) => toBool01(getField(row, "lses"))],
  ["lsee", "boolean", (row) => toBool01(getField(row, "lsee"))],
  ["rnwn", "boolean", (row) => toBool01(getField(row, "rnwn"))],
  ["rnww", "boolean", (row) => toBool01(getField(row, "rnww"))],
  ["rn", "boolean", (row) => toBool01(getField(row, "rn"))],
  ["rnen", "boolean", (row) => toBool01(getField(row, "rnen"))],
  ["rnee", "boolean", (row) => toBool01(getField(row, "rnee"))],
  ["re", "boolean", (row) => toBool01(getField(row, "re"))],
  ["rm", "boolean", (row) => toBool01(getField(row, "rm"))],
  ["rw", "boolean", (row) => toBool01(getField(row, "rw"))],
  ["rsws", "boolean", (row) => toBool01(getField(row, "rsws"))],
  ["rsww", "boolean", (row) => toBool01(getField(row, "rsww"))],
  ["rs", "boolean", (row) => toBool01(getField(row, "rs"))],
  ["rses", "boolean", (row) => toBool01(getField(row, "rses"))],
  ["rsee", "boolean", (row) => toBool01(getField(row, "rsee"))],
  ["lother", "boolean", (row) => toBool01(getField(row, "lother"))],
  ["rother", "boolean", (row) => toBool01(getField(row, "rother"))],
  ["l_axillar", "boolean", (row) => toBool01(getField(row, "l_axillar"))],
  ["r_axillar", "boolean", (row) => toBool01(getField(row, "r_axillar"))],
  ["exam_reason", "int4", (row) => toStrictInt(getField(row, "exam_reason"))],
  [
    "exam_reason_text",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "exam_reason_text")),
  ],
  [
    "exam_reason_memotext",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "exam_reason_memotext")),
  ],
  [
    "pain_l_duration",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "pain_l_duration")),
  ],
  [
    "pain_r_duration",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "pain_r_duration")),
  ],
  [
    "mobile_updated",
    "int4",
    (row) => toMobileUpdatedEpoch(getField(row, "mobile_updated")),
  ],
  ["mobile_loc", "int4", (row) => toStrictInt(getField(row, "mobile_loc"))],
  [
    "bct_l_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "bct_l_date")),
  ],
  [
    "bct_r_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "bct_r_date")),
  ],
  [
    "patient_cancer_age",
    "int4",
    (row) => toStrictInt(getField(row, "patient_cancer_age")),
  ],
  [
    "daughter_cancer_age",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "daughter_cancer_age")),
  ],
  [
    "daughter_cancer_age_more",
    "boolean",
    (row) => toBool01(getField(row, "daughter_cancer_age_more")),
  ],
  [
    "sister_cancer_age_more",
    "boolean",
    (row) => toBool01(getField(row, "sister_cancer_age_more")),
  ],
  [
    "other_cancer_age_more",
    "boolean",
    (row) => toBool01(getField(row, "other_cancer_age_more")),
  ],
  [
    "stophormone_yrs",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "stophormone_yrs")),
  ],
  [
    "ca_hormone_use",
    "boolean",
    (row) => toBool01(getField(row, "ca_hormone_use")),
  ],
  [
    "ca_hormone_yrs",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "ca_hormone_yrs")),
  ],
  [
    "stop_ca_hormone_yrs",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "stop_ca_hormone_yrs")),
  ],
  [
    "stop_contr_yrs",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "stop_contr_yrs")),
  ],
  [
    "rm_l_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "rm_l_date")),
  ],
  [
    "rm_r_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "rm_r_date")),
  ],
  [
    "ri_l_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "ri_l_date")),
  ],
  [
    "ri_r_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "ri_r_date")),
  ],
  [
    "fna_l_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "fna_l_date")),
  ],
  [
    "fna_r_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "fna_r_date")),
  ],
  [
    "fnx_l_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "fnx_l_date")),
  ],
  [
    "fnx_r_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "fnx_r_date")),
  ],
  [
    "send_exam_login_name",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "send_exam_login_name")),
  ],
  ["appointment", "int4", (_row, ctx) => ctx.appointmentId],
];

/** คีย์ MSSQL สำหรับแต่ละคอลัมน์ปลายทาง (ค่าเริ่มต้น = ชื่อคอลัมน์เดียวกัน) */
const EXAMINATION_MSSQL_SOURCE = {
  old_exam_id: "exam_id",
  old_pid: "pid",
  patient: "pid",
  pregnant: "pragnant",
  appointment: "schedule_id",
};

function mssqlSourceKey(pgColumn) {
  return EXAMINATION_MSSQL_SOURCE[pgColumn] ?? pgColumn;
}

function sourceRawNonempty(v) {
  if (v == null) return false;
  return (
    String(v)
      .replace(/^\uFEFF/, "")
      .trim() !== ""
  );
}

function sortExamIds(ids) {
  const out = [...ids];
  out.sort((a, b) => {
    try {
      const aa = BigInt(a);
      const bb = BigInt(b);
      return aa < bb ? -1 : aa > bb ? 1 : 0;
    } catch {
      return String(a).localeCompare(String(b));
    }
  });
  return out;
}

/**
 * ตรวจทุกฟิลด์ที่จะ insert: แหล่งมีค่าแต่แมปไม่ได้ / FK ไม่ตรง / parse ล้มเหลว
 * @returns {{ field: string, reason: string, message: string, source_raw: unknown, mapped: unknown, detail?: object }[]}
 */
function collectExaminationFieldIssues({
  row,
  context,
  mappedByName,
  patientCol,
}) {
  const issues = [];
  const patientField = patientCol === "patient_id" ? "patient_id" : "patient";

  const pidRaw = getField(row, "pid");
  if (normPid(pidRaw) !== "" && context.patientId == null) {
    issues.push({
      field: patientField,
      reason: "patient_not_resolved",
      message: "มี pid ในแหล่งข้อมูล แต่ไม่พบใน public.patient_info",
      source_raw: pidRaw,
      mapped: mappedByName.get("patient") ?? null,
    });
  }

  const schedRaw = getField(row, "schedule_id");
  const schedInt = toStrictInt(schedRaw);
  if (schedInt != null && context.appointmentId == null) {
    issues.push({
      field: "appointment",
      reason: "appointment_not_resolved",
      message: "มี schedule_id แต่ไม่พบ appointment.old_db_id ที่ตรงกัน",
      source_raw: schedRaw,
      mapped: mappedByName.get("appointment") ?? null,
    });
  }

  const skipGeneric = new Set([
    "patient",
    "appointment",
    "referring_md",
    "old_exam_id",
    "old_pid",
  ]);

  for (const [col, pgType] of INSERT_DEFS) {
    if (skipGeneric.has(col)) continue;

    const srcKey = mssqlSourceKey(col);
    const srcRaw = getField(row, srcKey);
    const mapped = mappedByName.get(col);

    if (pgType === "timestamp" && sourceRawNonempty(srcRaw) && mapped == null) {
      issues.push({
        field: col,
        reason: "timestamp_parse_failed",
        message: "วันที่/เวลาในแหล่งข้อมูลแปลงไม่ได้",
        source_raw: srcRaw,
        mapped: null,
      });
      continue;
    }

    if (pgType === "boolean" && sourceRawNonempty(srcRaw) && mapped == null) {
      issues.push({
        field: col,
        reason: "boolean_parse_failed",
        message:
          "ค่า boolean ในแหล่งข้อมูลไม่รู้จัก (ไม่ใช่ 0/1/Y/N/true/false ฯลฯ)",
        source_raw: srcRaw,
        mapped: null,
      });
      continue;
    }

    if (pgType === "int4" && col === "mobile_updated") {
      const sentinel = ["0", "1"].includes(String(srcRaw ?? "").trim());
      if (sourceRawNonempty(srcRaw) && mapped == null && !sentinel) {
        issues.push({
          field: col,
          reason: "epoch_parse_failed",
          message: "ค่า mobile_updated แปลงเป็น unix epoch ไม่ได้",
          source_raw: srcRaw,
          mapped: null,
        });
      }
      continue;
    }

    if (pgType === "int4" && sourceRawNonempty(srcRaw) && mapped == null) {
      issues.push({
        field: col,
        reason: "integer_parse_failed",
        message: "ค่าตัวเลขในแหล่งข้อมูลไม่ใช่จำนวนเต็มที่ถูกต้อง",
        source_raw: srcRaw,
        mapped: null,
      });
    }
  }

  return issues;
}

function buildFieldIssueSummary(recordIssues) {
  /** @type {Record<string, Record<string, number>>} */
  const summaryByField = {};
  /** @type {Record<string, number>} */
  const summaryByReason = {};

  for (const rec of recordIssues) {
    for (const fi of rec.fieldIssues ?? []) {
      const f = fi.field;
      const r = fi.reason;
      if (!summaryByField[f]) summaryByField[f] = {};
      summaryByField[f][r] = (summaryByField[f][r] ?? 0) + 1;
      summaryByReason[r] = (summaryByReason[r] ?? 0) + 1;
    }
  }
  return { summaryByField, summaryByReason };
}

/** สะสม field issues จากทุก chunk ก่อนเขียนไฟล์เดียวตอนจบ migration */
export function createFieldIssueAccumulator() {
  return {
    /** @type {Map<string, object>} */
    recordsByExamId: new Map(),
    totalFieldIssueCount: 0,
    referringNullified: 0,
    rowsInserted: 0,
    masterLoadError: null,
  };
}

export function mergeFieldIssueChunk(accumulator, chunkResult) {
  if (!accumulator || !chunkResult) return;
  const fi = chunkResult.fieldIssues;
  if (!fi) return;
  accumulator.totalFieldIssueCount += fi.totalFieldIssueCount ?? 0;
  accumulator.referringNullified += fi.referringNullified ?? 0;
  accumulator.rowsInserted += fi.rowsInserted ?? 0;
  if (fi.masterLoadError) accumulator.masterLoadError = fi.masterLoadError;
  for (const rec of fi.records ?? []) {
    const id = String(rec.exam_id);
    const prev = accumulator.recordsByExamId.get(id);
    if (prev) {
      prev.fieldIssues.push(...(rec.fieldIssues ?? []));
    } else {
      accumulator.recordsByExamId.set(id, {
        ...rec,
        fieldIssues: [...(rec.fieldIssues ?? [])],
      });
    }
  }
}

/**
 * เขียน log แบบ summary (อ่านง่าย) + records ครบทุก exam_id (คีย์ = exam_id)
 * ใช้ stream เพื่อไม่สร้าง string ยักษ์ใน memory
 */
export function writeFieldIssueLogFile(logPath, payload) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, "w");
  try {
    const head = {
      type: payload.type,
      generatedAt: payload.generatedAt,
      migrationKey: payload.migrationKey,
      summary: payload.summary,
    };
    const headJson = JSON.stringify(head, null, 2);
    fs.writeSync(fd, `${headJson.slice(0, -1)},\n  "records": {\n`);

    const keys = sortExamIds(Object.keys(payload.records ?? {}));
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const recJson = JSON.stringify(payload.records[k]);
      const suffix = i < keys.length - 1 ? ",\n" : "\n";
      fs.writeSync(fd, `    ${JSON.stringify(k)}: ${recJson}${suffix}`);
    }
    fs.writeSync(fd, "  }\n}\n");
  } finally {
    fs.closeSync(fd);
  }
}

export function buildFieldIssueLogPayload(accumulator, options = {}) {
  const allRecords = [...accumulator.recordsByExamId.values()];
  const { summaryByField, summaryByReason } =
    buildFieldIssueSummary(allRecords);

  /** @type {Record<string, object>} exam_id -> รายละเอียดปัญหา (แทน failedExamIds แยก) */
  const records = {};
  for (const rec of allRecords) {
    const id = String(rec.exam_id);
    records[id] = {
      exam_id: id,
      exam_id_raw: rec.exam_id_raw ?? id,
      schedule_id: rec.schedule_id ?? null,
      appointment_id: rec.appointment_id ?? null,
      patient_id: rec.patient_id ?? null,
      fieldIssues: rec.fieldIssues ?? [],
    };
  }

  return {
    type: "examination_field_issues",
    generatedAt: new Date().toISOString(),
    migrationKey: options.migrationKey ?? null,
    summary: {
      affectedRecordCount: allRecords.length,
      totalFieldIssueCount: accumulator.totalFieldIssueCount,
      rowsInserted: accumulator.rowsInserted,
      referringNullified: accumulator.referringNullified,
      masterLoadError: accumulator.masterLoadError,
      byField: summaryByField,
      byReason: summaryByReason,
    },
    records,
  };
}

function assertStagingFromClause(stagingFromClause) {
  const t = String(stagingFromClause ?? "").trim();
  if (!/^\w+\.\w+$/.test(t)) {
    throw new Error(
      `examination post-load: staging ต้องเป็น schema.table (a-z, 0-9, _): ได้ "${stagingFromClause}"`,
    );
  }
  return t;
}

let cachedPublicExaminationPatientCol = null;

/**
 * Django/Postgres มักใช้ patient_id; โมเดลเก่าใช้ patient — สอบถาม information_schema
 */
export async function resolvePublicExaminationPatientColumn(pgClient) {
  if (cachedPublicExaminationPatientCol)
    return cachedPublicExaminationPatientCol;
  const r = await pgClient.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'examination'
       AND column_name IN ('patient_id', 'patient')
     ORDER BY CASE column_name
       WHEN 'patient_id' THEN 0
       WHEN 'patient' THEN 1
     END
     LIMIT 1`,
  );
  if (r.rows.length === 0) {
    cachedPublicExaminationPatientCol = "patient";
  } else {
    cachedPublicExaminationPatientCol = r.rows[0].column_name;
  }
  return cachedPublicExaminationPatientCol;
}

/**
 * จับ patient จากข้อมูลบน staging ที่ load ลง PG จริง (ตรงกับ unnest) แทน in-memory จาก mssql
 * เพื่อไม่เสีย key เวลา pid รูปแบบ/ชนิดต่างจาก getField+String
 */
export async function runExaminationChunkPostLoad(
  pgClient,
  mssqlRows,
  stagingFromClause = "migrate_stg.examination_mssql",
  options = {},
) {
  const verbose = options.verbose === true;
  const log = (msg) => {
    if (verbose) console.error(msg);
  };

  const failingExamIdSet = new Set();
  let totalFieldIssueCount = 0;
  /** @type {Map<string, { exam_id: string, exam_id_raw: string, schedule_id: number|null, appointment_id: number|null, patient_id: number|null, fieldIssues: any[] }>} */
  const recordsWithIssues = new Map();

  function recordRowFieldIssues(examId, meta, fieldIssues) {
    if (fieldIssues.length === 0) return;
    failingExamIdSet.add(examId);
    totalFieldIssueCount += fieldIssues.length;

    let rec = recordsWithIssues.get(examId);
    if (!rec) {
      rec = {
        exam_id: examId,
        exam_id_raw: meta.examIdRaw,
        schedule_id: meta.scheduleId,
        appointment_id: meta.appointmentId,
        patient_id: meta.patientId,
        fieldIssues: [],
      };
      recordsWithIssues.set(examId, rec);
    }
    rec.fieldIssues.push(...fieldIssues);
  }

  const stg = assertStagingFromClause(stagingFromClause);
  const rows = distinctOnNormExamId(mssqlRows);
  if (rows.length === 0) {
    return { failedExamIds: [], fieldIssues: null };
  }

  const migrateRowMode = options.migrateRowMode ?? "overwrite";

  const examIds = rows
    .map((r) => normExamId(getField(r, "exam_id")))
    .filter((id) => id !== "" && isDigitsOnly(id));

  if (examIds.length === 0) {
    return { failedExamIds: [], fieldIssues: null };
  }

  const chunkPids = rows
    .map((r) => normPid(getField(r, "pid")))
    .filter((p) => p !== "");
  await ensurePlaceholderPatientInfo(pgClient, chunkPids);

  const mssqlExamU = rows.map((r) => String(getField(r, "exam_id") ?? ""));
  const { rows: stgCountRow } = await pgClient.query(
    `SELECT count(*)::int AS c FROM ${stg} s`,
  );
  const stgC = stgCountRow[0]?.c ?? 0;

  /**
   * unnest(ค่า exam จาก mssql) JOIN staging ด้วย norm_exam_id — รองรับกรณี String(mssql) กับ s.exam_id
   * (หลัง toStr ใน migrate) ไม่เหมือนกันทีละอักขระ
   */
  const bridgeRes = await pgClient.query(
    `SELECT DISTINCT ON (m.u)
       m.u::text AS u,
       p.id AS patient_id
     FROM unnest($1::text[]) AS m(u)
     INNER JOIN ${stg} s
       ON NULLIF(migrate_stg.norm_exam_id(m.u::text), '')::text
          = NULLIF(migrate_stg.norm_exam_id(s.exam_id::text), '')::text
     LEFT JOIN public.patient_info p
       ON migrate_stg.norm_pid(p.pid::text) = migrate_stg.norm_pid(s.pid)
     WHERE NULLIF(migrate_stg.norm_exam_id(m.u::text), '')::text ~ '^[0-9]+$'
     ORDER BY m.u, s.exam_id`,
    [mssqlExamU],
  );
  const mssqlUToPatient = new Map(
    bridgeRes.rows.map((r) => [r.u, r.patient_id]),
  );
  const withPatient = bridgeRes.rows.filter((r) => r.patient_id != null).length;
  const withoutPatient = mssqlUToPatient.size - withPatient;
  if (mssqlUToPatient.size === 0 && stgC > 0) {
    log(
      `>>> [examination] post-load: มี staging ${stgC} แต่ bridge mssql↔stg ไม่ได้ mapping (ตรวจ exam_id ตรง staging หรือยัง)`,
    );
  } else {
    log(
      `>>> [examination] post-load: staging ${stgC} แถว, bridge ได้ ${mssqlUToPatient.size} ราย (patient_info ตรง ${withPatient} ราย, ไม่ตรง/ว่าง ${withoutPatient} ราย — ยัง insert examination โดย patient=null ได้)`,
    );
  }

  const patientCol = await resolvePublicExaminationPatientColumn(pgClient);
  if (patientCol !== "patient") {
    log(
      `>>> [examination] post-load: ตาราง public.examination ใช้คอลัมน์ \`${patientCol}\` แทน \`patient\` — insert อัปเดตให้ตรงฐาน`,
    );
  }

  /** Schedule_ID จาก MSSQL อยู่ที่ appointment.old_db_id; id เป็น serial ไม่เท่า schedule เสมอ */
  const scheduleKeys = Array.from(
    new Set(
      rows
        .map((r) => {
          const n = toStrictInt(getField(r, "schedule_id"));
          return n == null ? null : String(n);
        })
        .filter((k) => k != null),
    ),
  );

  await ensurePlaceholderAppointment(pgClient, scheduleKeys);

  const scheduleKeyToAppointmentId = new Map();
  if (scheduleKeys.length > 0) {
    const { rows: apptRows } = await pgClient.query(
      `SELECT id, btrim(old_db_id::text) AS k
       FROM public.appointment
       WHERE btrim(old_db_id::text) = ANY($1::text[])`,
      [scheduleKeys],
    );
    for (const r of apptRows) {
      if (r.k != null && r.k !== "")
        scheduleKeyToAppointmentId.set(String(r.k), r.id);
    }
  }

  // overwrite mode: คง `id` เดิมของแถวที่มีอยู่ โดยไม่ใช้ DELETE+INSERT
  // (ถ้าแถวเก่าอยู่แล้ว เราจะ UPDATE ด้วย `old_exam_id`; ถ้าไม่มีก็ INSERT ใหม่)

  const referringIdx = INSERT_DEFS.findIndex(
    ([name]) => name === "referring_md",
  );
  const chunkReferringNames = rows.map((r) => getField(r, "referring_md"));
  const referringIdByFullname = await ensureReferringMdByFullnames(
    pgClient,
    chunkReferringNames,
  );

  const arrays = INSERT_DEFS.map(() => []);
  const insertedExamIds = [];

  for (const row of rows) {
    const examId = normExamId(getField(row, "exam_id"));
    const u = String(getField(row, "exam_id") ?? "");

    if (examId === "" || !isDigitsOnly(examId)) {
      if (sourceRawNonempty(getField(row, "exam_id"))) {
        const badId = String(getField(row, "exam_id") ?? "").trim();
        recordRowFieldIssues(
          badId || "(empty)",
          {
            examIdRaw: u,
            scheduleId: toStrictInt(getField(row, "schedule_id")),
            appointmentId: null,
            patientId: null,
          },
          [
            {
              field: "old_exam_id",
              reason: "invalid_exam_id",
              message: "exam_id ในแหล่งข้อมูลไม่ใช่ตัวเลขที่ใช้ migrate ได้",
              source_raw: getField(row, "exam_id"),
              mapped: null,
            },
          ],
        );
      }
      continue;
    }

    const patientId = mssqlUToPatient.get(u) ?? null;
    const scheduleId = toStrictInt(getField(row, "schedule_id"));
    const scheduleKey = scheduleId == null ? null : String(scheduleId);
    const appointmentId =
      scheduleKey == null
        ? null
        : (scheduleKeyToAppointmentId.get(scheduleKey) ?? null);
    const context = { patientId, appointmentId };
    const rowMeta = {
      examIdRaw: u,
      scheduleId,
      appointmentId,
      patientId,
    };

    /** @type {Map<string, unknown>} */
    const mappedByName = new Map();

    for (let i = 0; i < INSERT_DEFS.length; i++) {
      const [colName] = INSERT_DEFS[i];
      let v;
      if (i === referringIdx) {
        const nameRaw = getField(row, "referring_md");
        const key = referringMdMatchKey(nameRaw);
        v =
          key === ""
            ? null
            : (referringIdByFullname.get(key) ?? null);
      } else {
        v = INSERT_DEFS[i][2](row, context);
      }
      mappedByName.set(colName, v);
      arrays[i].push(v);
    }

    insertedExamIds.push(examId);

    const fieldIssues = collectExaminationFieldIssues({
      row,
      context,
      mappedByName,
      patientCol,
    });
    recordRowFieldIssues(examId, rowMeta, fieldIssues);
  }

  if (arrays[0].length === 0) {
    log(
      `>>> [examination] post-load: จะ insert 0 แถว (map patient ${mssqlUToPatient.size} ราย; กรอง exam/schedule)`,
    );
    return buildChunkFieldIssueResult();
  }

  const colList = INSERT_DEFS.map(([name], idx) =>
    idx === 2 ? patientCol : name,
  ).join(", ");
  const unnestArgs = INSERT_DEFS.map(
    ([, type], idx) => `$${idx + 1}::${type}[]`,
  ).join(", ");

  const colNames = INSERT_DEFS.map(([name], idx) => (idx === 2 ? patientCol : name));
  const unnestFrom = `FROM unnest(${unnestArgs}) AS src(${colNames.join(", ")})`;
  const setExprs = colNames
    .map((c) => `${c} = src.${c}`)
    .join(", ");

  let upd;
  if (migrateRowMode !== "insert-only") {
    upd = await pgClient.query(
      `
      UPDATE public.examination AS t
      SET ${setExprs}
      ${unnestFrom}
      WHERE t.old_exam_id::text = src.old_exam_id::text;
      `,
      arrays,
    );
  }

  const ins = await pgClient.query(
    `
    INSERT INTO public.examination (${colList})
    SELECT ${colList}
    ${unnestFrom}
    WHERE NOT EXISTS (
      SELECT 1 FROM public.examination t2
      WHERE t2.old_exam_id::text = src.old_exam_id::text
    );
    `,
    arrays,
  );

  if (migrateRowMode !== "insert-only") {
    log(
      `>>> [examination] post-load: update+insert public.examination (update=${upd?.rowCount ?? 0}, insert=${ins.rowCount ?? arrays[0].length}) แถว (คอลัมน์ patient → ${patientCol})`,
    );
  } else {
    log(
      `>>> [examination] post-load: insert public.examination แล้ว ${ins.rowCount ?? arrays[0].length} แถว (คอลัมน์ patient → ${patientCol})`,
    );
  }

  // หลัง insert: sync sequence เผื่อกรณีมี row ที่ไม่เคยมีใน PG
  if (cols.has("id")) {
    await pgClient.query(`
      SELECT setval(
        pg_get_serial_sequence('public.examination', 'id'),
        COALESCE((SELECT MAX(id) + 1 FROM public.examination), 1),
        false
      )
      WHERE pg_get_serial_sequence('public.examination', 'id') IS NOT NULL;
    `);
  }

  // หลัง migrate: ตรวจว่าแถวที่ควร insert มีจริงใน PG
  if (insertedExamIds.length > 0) {
    const { rows: pgRows } = await pgClient.query(
      `SELECT old_exam_id::text AS exam_id FROM public.examination WHERE old_exam_id = ANY($1::text[])`,
      [insertedExamIds],
    );
    const present = new Set(pgRows.map((r) => String(r.exam_id)));
    for (const eid of insertedExamIds) {
      if (present.has(eid)) continue;
      recordRowFieldIssues(
        eid,
        {
          examIdRaw: eid,
          scheduleId: null,
          appointmentId: null,
          patientId: null,
        },
        [
          {
            field: "_record",
            reason: "insert_missing_after_migrate",
            message: "แมปและ insert แล้ว แต่ไม่พบแถวใน public.examination",
            source_raw: eid,
            mapped: null,
          },
        ],
      );
    }
  }

  return buildChunkFieldIssueResult();

  function buildChunkFieldIssueResult() {
    const failedExamIds = sortExamIds(failingExamIdSet);
    const hasIssues = totalFieldIssueCount > 0;
    return {
      failedExamIds,
      fieldIssues: hasIssues
        ? {
            totalFieldIssueCount,
            referringNullified: 0,
            masterLoadError: null,
            records: [...recordsWithIssues.values()],
            rowsInserted: ins?.rowCount ?? arrays[0]?.length ?? 0,
          }
        : null,
    };
  }
}
