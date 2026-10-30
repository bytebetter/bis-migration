/**
 * history_report.previous_data — ก้อนเดียวกับที่ Backoffice เก็บตอนกด Sign to PACs
 * (props ของ MyDocument ใน dialog-exam-PDF.tsx) หน้าประวัติรายงาน render PDF จากก้อนนี้ตรง ๆ
 *   { formData, mamogram, examgeneral, ultrasound, procedureHistoryLines, interviewHistory }
 *
 * formData = examination ตาม DOCTOR_CASE_EXAMINATION_PDF_FIELDS (doctor-query-utils.ts)
 * ส่วนประวัติคนไข้ลอกจาก useExamProcedureHistory + src/utils/exam-pdf-clinical-history.ts
 * ฝั่ง Backoffice เปลี่ยน field / ข้อความ เมื่อไหร่ ต้องแก้ไฟล์นี้ตาม (import ข้าม repo ไม่ได้)
 */

const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** useExamProcedureHistory ขอ limit 30 แถวล่าสุด */
const INTERVIEW_ROW_LIMIT = 30;

export const PATIENT_FIELDS = [
  "id",
  "pid",
  "hn",
  "photo",
  "prefix_th",
  "first_name_th",
  "last_name_th",
  "first_name_en",
  "last_name_en",
  "date_of_birth",
  "short_note",
];
export const APPOINTMENT_FIELDS = ["infectious_disease", "referring_md"];
export const COSIGN_FIELDS = [
  "id",
  "first_name",
  "last_name",
  "first_name_en",
  "last_name_en",
];
export const CASE_OWNER_FIELDS = ["id", "first_name_en", "last_name_en"];
const PACS_SYNC_INFO_FIELDS = [
  "id",
  "modality",
  "end_time",
  "is_mark_del",
  "accession_id",
];

/** ลำดับและป้ายตรงฟอร์ม tech interview */
const PROCEDURE_DEFINITIONS = [
  { fieldLabel: "Implants, Reconstruction", fieldName: "irr" },
  { fieldLabel: "Reduction mammoplasty", fieldName: "rm" },
  { fieldLabel: "Removed implantation", fieldName: "ri" },
  { fieldLabel: "Fine Needle aspiration", fieldName: "fna" },
  { fieldLabel: "Fine Needle Aspiration", fieldName: "fnx", location: "axilla" },
  { fieldLabel: "Biopsy", fieldName: "biopsy" },
  { fieldLabel: "Excision/Lumpectomy", fieldName: "lump" },
  { fieldLabel: "Incision and Drainage", fieldName: "id" },
  { fieldLabel: "BCS/BCT", fieldName: "bct" },
  { fieldLabel: "Mastectomy", fieldName: "mast" },
  { fieldLabel: "Chemotherapy", fieldName: "chemo" },
  { fieldLabel: "Radiation therapy", fieldName: "rad" },
];

export const PROCEDURE_DATE_FIELDS = PROCEDURE_DEFINITIONS.flatMap(
  ({ fieldName }) => [`${fieldName}_r_date`, `${fieldName}_l_date`],
);

export const INTERVIEW_FIELDS = [
  "id",
  "exam_date",
  "prev_mammo_date",
  "prev_mammo_loc",
  "mother_cancer",
  "mother_cancer_age",
  "sister_cancer",
  "sister_cancer_age",
  "grandmother_cancer",
  "grandmother_cancer_age",
  "daughter_cancer",
  "daughter_cancer_age",
  "other_cancer",
  "other_cancer_age",
];

function pick(row, fields) {
  if (row == null) return null;
  return Object.fromEntries(fields.map((f) => [f, row[f] ?? null]));
}

/** "2026-07-01T00:00:00" -> "01/07/2569" (ค่าเป็น timestamp ไม่มี tz ใช้ตำแหน่งตัวอักษรได้) */
function formatBeDate(value) {
  if (!value) return null;
  const year = Number(value.slice(0, 4)) + 543;
  return `${value.slice(8, 10)}/${value.slice(5, 7)}/${year}`;
}

function locationPhrase(side, location) {
  return location === "axilla" ? `at ${side} axilla` : `on ${side} breast`;
}

/** เรียง Right -> Left ให้ตรงคอลัมน์ฟอร์ม tech */
function buildProcedureHistoryLines(dates) {
  const lines = [];
  for (const { fieldLabel, fieldName, location } of PROCEDURE_DEFINITIONS) {
    const right = formatBeDate(dates[`${fieldName}_r_date`]);
    const left = formatBeDate(dates[`${fieldName}_l_date`]);
    if (right) {
      lines.push(`${fieldLabel} ${locationPhrase("right", location)} dated ${right}`);
    }
    if (left) {
      lines.push(`${fieldLabel} ${locationPhrase("left", location)} dated ${left}`);
    }
  }
  return lines;
}

function hasAgeValue(age) {
  return age != null && String(age).trim() !== "";
}

function hasFamilyCancerData(row) {
  return (
    hasAgeValue(row.mother_cancer_age) ||
    hasAgeValue(row.sister_cancer_age) ||
    hasAgeValue(row.grandmother_cancer_age) ||
    hasAgeValue(row.daughter_cancer_age) ||
    hasAgeValue(row.other_cancer_age) ||
    Boolean(
      row.mother_cancer ||
        row.sister_cancer ||
        row.grandmother_cancer ||
        row.daughter_cancer ||
        row.other_cancer,
    )
  );
}

/** ท้ายวันตรวจตามเวลาไทย (หน้าเว็บใช้ dayjs(exam_date).endOf("day") บนเครื่องผู้ใช้) */
function bangkokDayEndMs(date) {
  const dayStart =
    Math.floor((date.getTime() + BKK_OFFSET_MS) / DAY_MS) * DAY_MS;
  return dayStart + DAY_MS - 1 - BKK_OFFSET_MS;
}

/**
 * ประวัติจาก exam ทุกตัวของคนไข้จนถึงวันตรวจของ exam นี้ — exam ไม่มี exam_date หน้าเว็บไม่ query เลย
 * @param {Record<string, any>} exam
 * @param {Record<string, any>[]} historyRows exam ของคนไข้คนนี้ เรียง exam_date ล่าสุดก่อน
 */
function buildClinicalHistory(exam, historyRows) {
  if (exam.patient == null || exam.exam_date == null) {
    return { procedureHistoryLines: [], interviewHistory: null };
  }
  const endMs = bangkokDayEndMs(exam.exam_date);
  const rows = historyRows.filter((r) => r.exam_date.getTime() <= endMs);

  const dates = {};
  for (const field of PROCEDURE_DATE_FIELDS) {
    for (const row of rows) {
      const value = row[field];
      if (value && (!dates[field] || value > dates[field])) dates[field] = value;
    }
  }

  const interviewRows = rows.slice(0, INTERVIEW_ROW_LIMIT);
  const interview = interviewRows.find(hasFamilyCancerData) ?? interviewRows[0];
  return {
    procedureHistoryLines: buildProcedureHistoryLines(dates),
    interviewHistory: pick(interview, INTERVIEW_FIELDS),
  };
}

/** isSignableModality ใน dialog-exam-PDF — ฉบับที่ sign มีได้ทั้ง Report และ Sign to PACs */
function isSignable(state) {
  return String(state) === "1" || String(state) === "3";
}

/** @param {string} value timestamp ไม่มี tz ของระบบเก่า = เวลาไทย */
function bangkokNaiveToDate(value) {
  return value ? new Date(`${value}+07:00`) : null;
}

/**
 * date_created ของแถว — ไม่รู้เวลา sign จริง จึงใช้เวลาแก้ report ล่าสุด
 * แถวจากระบบเก่าไม่มี date_* (ไม่ได้ map มา) ใช้ exam_date ของ report แทน
 */
export function resolveSignedAt({ formData, mamogram, ultrasound }) {
  const times = [mamogram, ultrasound]
    .filter(Boolean)
    .map(
      (r) => r.date_updated ?? r.date_created ?? bangkokNaiveToDate(r.exam_date),
    )
    .filter(Boolean)
    .map((d) => d.getTime());
  if (times.length > 0) return new Date(Math.max(...times));
  return formData.exam_date ?? null;
}

/**
 * @param {{
 *   exam: Record<string, any>,
 *   children: Record<string, Record<string, any>[]>,
 *   spotShapes: Map<string, Record<string, any>[]>,
 *   patient: Record<string, any> | undefined,
 *   appointment: Record<string, any> | undefined,
 *   users: Map<string, Record<string, any>>,
 *   historyRows: Record<string, any>[],
 * }} p
 */
export function buildPreviousData({
  exam,
  children,
  spotShapes,
  patient,
  appointment,
  users,
  historyRows,
}) {
  const examinationGeneral = children.examination_general.map((g) => ({
    ...g,
    cosign: pick(users.get(g.cosign), COSIGN_FIELDS),
  }));
  const formData = {
    ...exam,
    ...children,
    examination_general: examinationGeneral,
    pacs_sync_infos: children.pacs_sync_infos.map((r) =>
      pick(r, PACS_SYNC_INFO_FIELDS),
    ),
    spots: children.spots.map((s) => ({
      ...s,
      spot_shapes: spotShapes.get(String(s.id)) ?? [],
    })),
    // m2m ที่ไม่ได้ขยาย field — Directus ส่งเป็น id แถว junction
    spot_technicians: children.spot_technicians.map((r) => r.id),
    patient: pick(patient, PATIENT_FIELDS),
    appointment: pick(appointment, APPOINTMENT_FIELDS),
    case_owner_doctor: pick(users.get(exam.case_owner_doctor), CASE_OWNER_FIELDS),
  };

  const mam = formData.mam[0];
  const us = formData.us[0];
  return {
    formData,
    mamogram: isSignable(mam?.state) ? mam : null,
    examgeneral: examinationGeneral[0] ?? null,
    ultrasound: isSignable(us?.state) ? us : null,
    ...buildClinicalHistory(exam, historyRows),
  };
}
