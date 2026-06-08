import { hasNumericSourceRange } from "./migrateMssqlBindings.mjs";

/** profile ที่รองรับ source-key-range (ค่า key ตัวเลข) */
export const SOURCE_KEY_RANGE_SUPPORTED = {
  examination: { field: "Exam_ID", table: "dbo.examination" },
  examination_general: { field: "Exam_ID", table: "dbo.examination_general" },
  exam_recommend_birads45: {
    field: "Exam_ID",
    table: "dbo.EXAM_Recommend_BIRADS45",
  },
  billing: { field: "Exam_ID", table: "dbo.billing" },
  procedure: { field: "Exam_ID", table: "dbo.biopsy" },
  ultrasound: { field: "Exam_ID", table: "dbo.ultrasound" },
  ultrasound_mass: { field: "Exam_ID", table: "dbo.ultrasound_mass" },
  ultrasound_cyst: { field: "Exam_ID", table: "dbo.ultrasound_cyst" },
  mam: { field: "Exam_ID", table: "dbo.mammogram" },
  mam_mass: { field: "Exam_ID", table: "dbo.mammogram_mass" },
  mam_cal: { field: "Exam_ID", table: "dbo.mammogram_cal" },
  appointment: { field: "Schedule_ID", table: "dbo.schedule" },
};

const UNSUPPORTED_REASON = {
  patient_info:
    "PID เป็น varchar — ใช้ --source-index-range สำหรับลำดับแถวแทน",
  pacs_sync_info:
    "Accession_ID เป็น varchar — ใช้ --source-index-range สำหรับลำดับแถวแทน",
  appointment_reschedules:
    "SCHEDULE_LOG ไม่มี PK ตัวเลข — ใช้ --source-index-range สำหรับลำดับแถวแทน",
};

function supportedProfileList() {
  return Object.keys(SOURCE_KEY_RANGE_SUPPORTED).join(", ");
}

/**
 * @param {string} profileKey
 * @param {Record<string, unknown>} migration merged config
 * @param {boolean} hasSourceKeyCli ระบุ --source-key-* จาก CLI
 */
export function assertSourceKeyRangeSupported(
  profileKey,
  migration,
  hasSourceKeyCli = false,
) {
  if (profileKey in SOURCE_KEY_RANGE_SUPPORTED) return;

  const wantsKeyRange =
    hasSourceKeyCli || hasNumericSourceRange(migration);
  if (!wantsKeyRange) return;

  const reason =
    UNSUPPORTED_REASON[profileKey] ??
    "profile นี้ไม่มี key ตัวเลขที่รองรับ source-key-range";
  throw new Error(
    `[${profileKey}] ไม่รองรับ --source-key-range — ${reason}. ` +
      `ใช้ได้เฉพาะ profile: ${supportedProfileList()}`,
  );
}
