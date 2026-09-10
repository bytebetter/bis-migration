/**
 * รายการ index ฝั่ง MSSQL ที่ migrate pipeline ใช้ — ไล่จาก query จริงของแต่ละ step
 *
 * keys      = key column เรียงตามลำดับ (ต้องตรงลำดับ ORDER BY / keyset)
 * includes  = included column (ไม่ต้อง key lookup กลับตาราง)
 * legacyKeys= ใช้แทน keys เมื่อตารางไม่มีคอลัมน์ CreatedDate (โค้ดจะ fallback ไป keyset แบบเก่า)
 * optional  = ไม่สร้างให้ ถ้าไม่ใส่ --include-optional (index ใหญ่ / ได้ผลไม่ชัด)
 */
export const MIGRATE_INDEX_SPECS = [
  // ── state Sign to PACs (งานใหม่) ────────────────────────────────────────
  {
    key: "pacs_export_pdf",
    table: "PACS_EXPORT_PDF",
    keys: ["Exam_ID"],
    includes: ["RPT_TYPE", "Is_LatestRPT_Synced"],
    note: "lookup Sign to PACs — pacsExportSign.mjs ยิงต่อ chunk",
  },

  // ── ตารางหลัก: keyset CreatedDate → Exam_ID ─────────────────────────────
  { key: "examination_keyset", table: "examination", keys: ["CreatedDate", "Exam_ID"], legacyKeys: ["Exam_ID"], note: "keyset step 4 examination" },
  { key: "billing_keyset", table: "billing", keys: ["CreatedDate", "Exam_ID"], legacyKeys: ["Exam_ID"], note: "keyset step 5 billing" },
  { key: "exam_general_keyset", table: "examination_general", keys: ["CreatedDate", "Exam_ID"], legacyKeys: ["Exam_ID"], note: "keyset step 6 examination_general" },
  { key: "exam_recommend_keyset", table: "EXAM_Recommend_BIRADS45", keys: ["CreatedDate", "Exam_ID", "Recommend_ID"], legacyKeys: ["Exam_ID", "Recommend_ID"], note: "keyset step 7 exam_recommend_birads45" },
  { key: "biopsy_keyset", table: "biopsy", keys: ["CreatedDate", "Exam_ID", "BiopsyID"], legacyKeys: ["Exam_ID", "BiopsyID"], note: "OFFSET/FETCH step 9 procedure" },
  { key: "ultrasound_keyset", table: "ultrasound", keys: ["CreatedDate", "Exam_ID"], legacyKeys: ["Exam_ID"], note: "keyset step 10 ultrasound" },
  { key: "mammogram_keyset", table: "mammogram", keys: ["CreatedDate", "Exam_ID"], legacyKeys: ["Exam_ID"], note: "keyset step 11 mammogram" },

  // ── ตารางหลัก: detail IN (...) ตาม Exam_ID (ส่วนใหญ่ PK ครอบให้แล้ว) ────
  { key: "examination_examid", table: "examination", keys: ["Exam_ID"], note: "detail IN (...) / repair-from-log" },
  { key: "billing_examid", table: "billing", keys: ["Exam_ID"], note: "detail IN (...)" },
  { key: "exam_general_examid", table: "examination_general", keys: ["Exam_ID"], note: "detail IN (...)" },
  { key: "ultrasound_examid", table: "ultrasound", keys: ["Exam_ID"], note: "detail IN (...)" },
  { key: "mammogram_examid", table: "mammogram", keys: ["Exam_ID"], note: "detail IN (...)" },

  // ── ตารางลูก: keyset (CreatedDate, Exam_ID, child) ──────────────────────
  { key: "mam_cal_keyset", table: "mammogram_cal", keys: ["CreatedDate", "Exam_ID", "Described_Cal_ID"], legacyKeys: ["Exam_ID", "Described_Cal_ID"], note: "keyset step 12 mammogram_cal" },
  { key: "mam_mass_keyset", table: "mammogram_mass", keys: ["CreatedDate", "Exam_ID", "Described_Mass_ID"], legacyKeys: ["Exam_ID", "Described_Mass_ID"], note: "keyset step 13 mammogram_mass" },
  { key: "us_cyst_keyset", table: "ultrasound_cyst", keys: ["CreatedDate", "Exam_ID", "Described_Cyst_ID"], legacyKeys: ["Exam_ID", "Described_Cyst_ID"], note: "keyset step 14 ultrasound_cyst" },
  { key: "us_mass_keyset", table: "ultrasound_mass", keys: ["CreatedDate", "Exam_ID", "Described_Mass_ID"], legacyKeys: ["Exam_ID", "Described_Mass_ID"], note: "keyset step 15 ultrasound_mass" },

  // ── ตารางลูก: Exam_ID IN (...) — mam child counts + detail ตอน repair ───
  { key: "mam_cal_examid", table: "mammogram_cal", keys: ["Exam_ID", "Described_Cal_ID"], note: "นับ cal ต่อ exam ตอน migrate mammogram" },
  { key: "mam_mass_examid", table: "mammogram_mass", keys: ["Exam_ID", "Described_Mass_ID"], note: "นับ mass ต่อ exam ตอน migrate mammogram" },
  { key: "us_cyst_examid", table: "ultrasound_cyst", keys: ["Exam_ID", "Described_Cyst_ID"], note: "detail IN (...)" },
  { key: "us_mass_examid", table: "ultrasound_mass", keys: ["Exam_ID", "Described_Mass_ID"], note: "detail IN (...)" },

  // ── ตารางที่ไม่ได้คีย์ด้วย Exam_ID ──────────────────────────────────────
  { key: "patient_info_pid", table: "patient_info", keys: ["PID"], note: "detail IN (...) step 1 (keyset ใช้ sort key คำนวณ index ช่วยไม่ได้)" },
  { key: "schedule_id", table: "schedule", keys: ["Schedule_ID"], note: "keyset + detail IN (...) step 2 appointment" },
  { key: "pacs_sync_accession", table: "pacs_sync_info", keys: ["Accession_ID"], note: "keyset + detail IN (...) step 8" },
  {
    key: "schedule_log_activity",
    table: "SCHEDULE_LOG",
    keys: ["Activity"],
    includes: ["LogTime", "Schedule_ID", "Schedule_Datetime", "ModifiedDate", "Old_Schedule_Datetime"],
    optional: true,
    note: "step 3 กรอง Activity — ORDER BY เป็น COALESCE/%%physloc%% ยังต้อง sort อยู่ดี, index กว้าง",
  },
];
