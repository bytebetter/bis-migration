import {
  collectIdsFromFieldIssueLogCommon,
  collectIdsFromRunLogCommon,
} from "./repairFromLog.mjs";

/**
 * @typedef {object} RepairSpec
 * @property {string} tableLabel
 * @property {string} [recordIdLabel] ชื่อคีย์ใน log (แสดงในสรุป repair-from-log)
 * @property {RegExp} runLogPattern
 * @property {RegExp} fieldIssuePattern
 * @property {(runLog: object, idSet: Set<string>) => void} collectIdsFromRunLog
 * @property {(payload: object, idSet: Set<string>) => void} collectIdsFromFieldIssueLog
 */

/** @type {RepairSpec} */
export const REPAIR_SPEC_APPOINTMENT = {
  tableLabel: "appointment",
  recordIdLabel: "schedule_id",
  runLogPattern: /^migrate-.*\.json$/i,
  fieldIssuePattern: /^migration-field-issues-appointment-.*\.json$/i,
  collectIdsFromRunLog(runLog, idSet) {
    collectIdsFromRunLogCommon(runLog, idSet, {
      failedChunkIdFields: ["firstScheduleId", "lastScheduleId"],
    });
  },
  collectIdsFromFieldIssueLog(payload, idSet) {
    collectIdsFromFieldIssueLogCommon(payload, idSet, "schedule_id");
  },
};

/** @type {RepairSpec} */
export const REPAIR_SPEC_EXAMINATION = {
  tableLabel: "examination",
  recordIdLabel: "exam_id",
  runLogPattern: /^migrate-.*\.json$/i,
  fieldIssuePattern: /^migration-field-issues-examination.*\.json$/i,
  collectIdsFromRunLog(runLog, idSet) {
    collectIdsFromRunLogCommon(runLog, idSet, {
      failedChunkIdFields: ["firstExamId", "lastExamId"],
      listIdFields: ["failedExamIds"],
    });
  },
  collectIdsFromFieldIssueLog(payload, idSet) {
    collectIdsFromFieldIssueLogCommon(payload, idSet, "exam_id");
  },
};

/** @type {RepairSpec} */
export const REPAIR_SPEC_EXAMINATION_GENERAL = {
  tableLabel: "examination_general",
  recordIdLabel: "exam_id",
  runLogPattern: /^migrate-.*\.json$/i,
  fieldIssuePattern: /^migration-field-issues-examination_general-.*\.json$/i,
  collectIdsFromRunLog(runLog, idSet) {
    collectIdsFromRunLogCommon(runLog, idSet, {
      failedChunkIdFields: ["firstExamId", "lastExamId"],
    });
  },
  collectIdsFromFieldIssueLog(payload, idSet) {
    collectIdsFromFieldIssueLogCommon(payload, idSet, "exam_id");
  },
};

/** @type {RepairSpec} */
export const REPAIR_SPEC_EXAM_RECOMMEND_BIRADS45 = {
  tableLabel: "exam_recommend_birads45",
  recordIdLabel: "exam_id",
  runLogPattern: /^migrate-.*\.json$/i,
  fieldIssuePattern:
    /^migration-field-issues-exam_recommend_birads45-.*\.json$/i,
  collectIdsFromRunLog(runLog, idSet) {
    collectIdsFromRunLogCommon(runLog, idSet, {
      failedChunkIdFields: ["firstExamId", "lastExamId"],
    });
  },
  collectIdsFromFieldIssueLog(payload, idSet) {
    collectIdsFromFieldIssueLogCommon(payload, idSet, "exam_id");
  },
};

/** @type {RepairSpec} */
export const REPAIR_SPEC_BILLING = {
  tableLabel: "billing",
  recordIdLabel: "exam_id",
  runLogPattern: /^migrate-.*\.json$/i,
  fieldIssuePattern: /^migration-field-issues-billing-.*\.json$/i,
  collectIdsFromRunLog(runLog, idSet) {
    collectIdsFromRunLogCommon(runLog, idSet, {
      failedChunkIdFields: ["firstExamId", "lastExamId"],
    });
  },
  collectIdsFromFieldIssueLog(payload, idSet) {
    collectIdsFromFieldIssueLogCommon(payload, idSet, "exam_id");
  },
};

/** @type {RepairSpec} */
export const REPAIR_SPEC_PACS_SYNC_INFO = {
  tableLabel: "pacs_sync_info",
  recordIdLabel: "accession_id",
  runLogPattern: /^migrate-.*\.json$/i,
  fieldIssuePattern: /^migration-field-issues-pacs_sync_info-.*\.json$/i,
  collectIdsFromRunLog(runLog, idSet) {
    collectIdsFromRunLogCommon(runLog, idSet, {
      failedChunkIdFields: ["firstAccessionId", "lastAccessionId"],
    });
  },
  collectIdsFromFieldIssueLog(payload, idSet) {
    collectIdsFromFieldIssueLogCommon(payload, idSet, "accession_id");
  },
};

/** @type {RepairSpec} */
export const REPAIR_SPEC_PROCEDURE = {
  tableLabel: "procedure",
  recordIdLabel: "old_db_id",
  runLogPattern: /^migrate-.*\.json$/i,
  fieldIssuePattern: /^migration-field-issues-procedure-.*\.json$/i,
  collectIdsFromRunLog(runLog, idSet) {
    collectIdsFromRunLogCommon(runLog, idSet, {
      failedChunkIdFields: ["firstKey", "lastKey"],
    });
    for (const r of Array.isArray(runLog.tableResults)
      ? runLog.tableResults
      : [runLog]) {
      for (const ch of r.chunkResults ?? []) {
        if (ch?.firstKey) idSet.add(String(ch.firstKey));
        if (ch?.lastKey) idSet.add(String(ch.lastKey));
      }
    }
  },
  collectIdsFromFieldIssueLog(payload, idSet) {
    for (const rec of Object.values(payload?.records ?? {})) {
      const e = rec?.exam_id;
      const b = rec?.biopsy_id;
      if (e != null && b != null) {
        idSet.add(`${String(e).trim()}_${String(b).trim()}`);
      } else if (e != null) {
        idSet.add(String(e).trim());
      }
    }
    collectIdsFromFieldIssueLogCommon(payload, idSet, "exam_id");
  },
};

/** @type {RepairSpec} */
export const REPAIR_SPEC_ULTRASOUND = {
  tableLabel: "ultrasound",
  recordIdLabel: "exam_id",
  runLogPattern: /^migrate-.*\.json$/i,
  fieldIssuePattern: /^migration-field-issues-ultrasound-.*\.json$/i,
  collectIdsFromRunLog(runLog, idSet) {
    collectIdsFromRunLogCommon(runLog, idSet, {
      failedChunkIdFields: ["firstExamId", "lastExamId"],
    });
  },
  collectIdsFromFieldIssueLog(payload, idSet) {
    collectIdsFromFieldIssueLogCommon(payload, idSet, "exam_id");
  },
};

/** @type {RepairSpec} */
export const REPAIR_SPEC_MAM = {
  tableLabel: "mammogram",
  recordIdLabel: "exam_id",
  runLogPattern: /^migrate-.*\.json$/i,
  fieldIssuePattern: /^migration-field-issues-mammogram-.*\.json$/i,
  collectIdsFromRunLog(runLog, idSet) {
    collectIdsFromRunLogCommon(runLog, idSet, {
      failedChunkIdFields: ["firstExamId", "lastExamId"],
    });
  },
  collectIdsFromFieldIssueLog(payload, idSet) {
    collectIdsFromFieldIssueLogCommon(payload, idSet, "exam_id");
  },
};

/** @type {RepairSpec} */
export const REPAIR_SPEC_MAM_CAL = {
  tableLabel: "mammogram_cal",
  recordIdLabel: "exam_id",
  runLogPattern: /^migrate-.*\.json$/i,
  fieldIssuePattern: /^migration-field-issues-mammogram_cal-.*\.json$/i,
  collectIdsFromRunLog(runLog, idSet) {
    collectIdsFromRunLogCommon(runLog, idSet, {
      failedChunkIdFields: ["firstExamId", "lastExamId"],
    });
  },
  collectIdsFromFieldIssueLog(payload, idSet) {
    collectIdsFromFieldIssueLogCommon(payload, idSet, "exam_id");
  },
};

/** @type {RepairSpec} */
export const REPAIR_SPEC_MAM_MASS = {
  tableLabel: "mammogram_mass",
  recordIdLabel: "exam_id",
  runLogPattern: /^migrate-.*\.json$/i,
  fieldIssuePattern: /^migration-field-issues-mammogram_mass-.*\.json$/i,
  collectIdsFromRunLog(runLog, idSet) {
    collectIdsFromRunLogCommon(runLog, idSet, {
      failedChunkIdFields: ["firstExamId", "lastExamId"],
    });
  },
  collectIdsFromFieldIssueLog(payload, idSet) {
    collectIdsFromFieldIssueLogCommon(payload, idSet, "exam_id");
    collectIdsFromFieldIssueLogCommon(payload, idSet, "described_mass_id");
  },
};

/** @type {RepairSpec} */
export const REPAIR_SPEC_ULTRASOUND_CYST = {
  tableLabel: "ultrasound_cyst",
  recordIdLabel: "exam_id",
  runLogPattern: /^migrate-.*\.json$/i,
  fieldIssuePattern: /^migration-field-issues-ultrasound_cyst-.*\.json$/i,
  collectIdsFromRunLog(runLog, idSet) {
    collectIdsFromRunLogCommon(runLog, idSet, {
      failedChunkIdFields: ["firstExamId", "lastExamId"],
    });
  },
  collectIdsFromFieldIssueLog(payload, idSet) {
    collectIdsFromFieldIssueLogCommon(payload, idSet, "exam_id");
  },
};

/** @type {RepairSpec} */
export const REPAIR_SPEC_ULTRASOUND_MASS = {
  tableLabel: "ultrasound_mass",
  recordIdLabel: "exam_id",
  runLogPattern: /^migrate-.*\.json$/i,
  fieldIssuePattern: /^migration-field-issues-ultrasound_mass-.*\.json$/i,
  collectIdsFromRunLog(runLog, idSet) {
    collectIdsFromRunLogCommon(runLog, idSet, {
      failedChunkIdFields: ["firstExamId", "lastExamId"],
    });
  },
  collectIdsFromFieldIssueLog(payload, idSet) {
    collectIdsFromFieldIssueLogCommon(payload, idSet, "exam_id");
  },
};

/** @type {RepairSpec} */
export const REPAIR_SPEC_PATIENT_INFO = {
  tableLabel: "patient_info",
  recordIdLabel: "pid",
  runLogPattern: /^migrate-.*\.json$/i,
  fieldIssuePattern: /^migration-field-issues-patient.*\.json$/i,
  collectIdsFromRunLog(runLog, idSet) {
    collectIdsFromRunLogCommon(runLog, idSet, {
      failedChunkIdFields: ["firstPid", "lastPid"],
      bisectField: "bisectOffendingPids",
    });
  },
  collectIdsFromFieldIssueLog(payload, idSet) {
    collectIdsFromFieldIssueLogCommon(payload, idSet, "pid");
  },
};

/** @type {RepairSpec} */
export const REPAIR_SPEC_APPOINTMENT_RESCHEDULES = {
  tableLabel: "appointment_reschedules",
  recordIdLabel: "log_key",
  runLogPattern: /^migrate-.*\.json$/i,
  fieldIssuePattern:
    /^migration-field-issues-appointment_reschedules-.*\.json$/i,
  collectIdsFromRunLog(runLog, idSet) {
    collectIdsFromRunLogCommon(runLog, idSet, {
      failedChunkIdFields: ["firstKey", "lastKey"],
    });
  },
  collectIdsFromFieldIssueLog(payload, idSet) {
    collectIdsFromFieldIssueLogCommon(payload, idSet, "log_key");
  },
};

/** profile → spec (ทุกตารางใน pipeline) */
export const REPAIR_SPEC_BY_PROFILE = {
  patient_info: REPAIR_SPEC_PATIENT_INFO,
  appointment: REPAIR_SPEC_APPOINTMENT,
  appointment_reschedules: REPAIR_SPEC_APPOINTMENT_RESCHEDULES,
  examination: REPAIR_SPEC_EXAMINATION,
  examination_general: REPAIR_SPEC_EXAMINATION_GENERAL,
  exam_recommend_birads45: REPAIR_SPEC_EXAM_RECOMMEND_BIRADS45,
  billing: REPAIR_SPEC_BILLING,
  pacs_sync_info: REPAIR_SPEC_PACS_SYNC_INFO,
  procedure: REPAIR_SPEC_PROCEDURE,
  ultrasound: REPAIR_SPEC_ULTRASOUND,
  mam: REPAIR_SPEC_MAM,
  mam_cal: REPAIR_SPEC_MAM_CAL,
  mam_mass: REPAIR_SPEC_MAM_MASS,
  ultrasound_cyst: REPAIR_SPEC_ULTRASOUND_CYST,
  ultrasound_mass: REPAIR_SPEC_ULTRASOUND_MASS,
};
