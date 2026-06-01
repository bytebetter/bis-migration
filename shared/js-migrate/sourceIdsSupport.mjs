/** profile ที่มี PK บน MSSQL — รองรับ --source-ids */
export const SOURCE_IDS_PK_PROFILES = {
  patient_info: {
    pkLabel: "PID",
    table: "dbo.patient_info",
    hint: "string เช่น 1234567890",
  },
  appointment: {
    pkLabel: "Schedule_ID",
    table: "dbo.schedule",
    hint: "เลข เช่น 100",
  },
  examination: {
    pkLabel: "Exam_ID",
    table: "dbo.examination",
    hint: "เลข เช่น 5000",
  },
  examination_general: {
    pkLabel: "Exam_ID",
    table: "dbo.examination_general",
    hint: "เลข เช่น 5000",
  },
  procedure: {
    pkLabel: "Exam_ID_BiopsyID",
    table: "dbo.biopsy",
    hint: "รูป Exam_ID_BiopsyID เช่น 5000_1",
  },
  pacs_sync_info: {
    pkLabel: "Accession_ID",
    table: "dbo.pacs_sync_info",
    hint: "string เช่น 5943407001",
  },
  ultrasound: {
    pkLabel: "Exam_ID",
    table: "dbo.ultrasound",
    hint: "เลข Exam_ID",
  },
  ultrasound_mass: {
    pkLabel: "Exam_ID",
    table: "dbo.ultrasound_mass",
    hint: "Exam_ID — ดึงทุก mass ของ exam",
  },
  ultrasound_cyst: {
    pkLabel: "Exam_ID",
    table: "dbo.ultrasound_cyst",
    hint: "Exam_ID — ดึงทุก cyst ของ exam",
  },
  mam: {
    pkLabel: "Exam_ID",
    table: "dbo.mammogram",
    hint: "เลข Exam_ID",
  },
  mam_mass: {
    pkLabel: "Exam_ID",
    table: "dbo.mammogram_mass",
    hint: "Exam_ID — ดึงทุก mass ของ exam",
  },
  mam_cal: {
    pkLabel: "Exam_ID",
    table: "dbo.mammogram_cal",
    hint: "Exam_ID — ดึงทุก cal ของ exam",
  },
};

const UNSUPPORTED_REASON = {
  appointment_reschedules:
    "SCHEDULE_LOG ไม่มี PK — ใช้ --source-index-range แทน",
};

/**
 * @param {string | string[] | null | undefined} raw
 * @returns {string[]}
 */
export function normalizeSourceIdsArray(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.map((id) => String(id).trim()).filter((s) => s !== "");
  }
  if (typeof raw === "string") {
    return parseSourceIdsString(raw);
  }
  throw new Error(
    `sourceIds ต้องเป็น array หรือ string คั่นด้วย comma — ได้ ${typeof raw}`,
  );
}

/**
 * @param {string} raw เช่น "100,200" หรือ "100"
 * @returns {string[]}
 */
export function parseSourceIdsString(raw) {
  const s = String(raw).trim();
  if (s === "") {
    throw new Error("--source-ids ต้องมีค่าอย่างน้อย 1 id");
  }
  return s
    .split(/[,;]+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

export const SOURCE_IDS_QUOTE_EXAMPLE =
  'npm run migrate:patient_info -- --source-ids "0000,1"';

/**
 * ค่าหลัง --source-ids ต้องเป็น argv เดียว (ครอบด้วย " ตอนรัน npm)
 *
 * @param {string[]} parts
 */
export function assertSourceIdsSingleArgvToken(parts) {
  if (parts.length > 1) {
    throw new Error(
      `--source-ids ต้องครอบค่าทั้งหมดด้วย " เสมอ — npm/shell แยกเป็น ${parts.length} args (${parts.join(", ")}). ตัวอย่าง: ${SOURCE_IDS_QUOTE_EXAMPLE}`,
    );
  }
  const v = parts[0];
  if (/\s/.test(v) && !/[,;]/.test(v)) {
    throw new Error(
      `--source-ids มีช่องว่างในค่า "${v}" — ใช้ comma ในค่าเดียวที่ครอบด้วย " เช่น ${SOURCE_IDS_QUOTE_EXAMPLE}`,
    );
  }
}

/** @param {Record<string, unknown> | undefined} migration */
export function hasExplicitSourceIds(migration) {
  return Object.hasOwn(migration ?? {}, "sourceIds");
}

/**
 * @param {string} profileKey
 * @param {Record<string, unknown>} migration
 * @param {boolean} hasSourceIdsCli
 */
export function assertSourceIdsSupported(profileKey, migration, hasSourceIdsCli) {
  const wants =
    hasSourceIdsCli ||
    (hasExplicitSourceIds(migration) &&
      normalizeSourceIdsArray(migration.sourceIds).length > 0);
  if (!wants) return;

  if (profileKey in SOURCE_IDS_PK_PROFILES) return;

  const reason =
    UNSUPPORTED_REASON[profileKey] ??
    "profile นี้ไม่รองรับ --source-ids";
  const supported = Object.keys(SOURCE_IDS_PK_PROFILES).join(", ");
  throw new Error(
    `[${profileKey}] ไม่รองรับ --source-ids — ${reason}. ใช้ได้: ${supported}`,
  );
}

/** @param {Record<string, unknown>} migration */
export function assertSourceIdsNoConflicts(migration, parsed) {
  if (!hasExplicitSourceIds(migration)) return;
  if (String(migration.migrateRunMode ?? "") === "repair-from-log") {
    throw new Error(
      "ใช้ --source-ids หรือ --migrate-run-mode repair-from-log อย่างใดอย่างหนึ่ง",
    );
  }
  if (parsed.hasSourceKeyCli) {
    throw new Error("ใช้ --source-ids หรือ --source-key-range อย่างใดอย่างหนึ่ง");
  }
  if (migration.sourceIndexFrom != null || migration.sourceIndexTo != null) {
    throw new Error("ใช้ --source-ids หรือ --source-index-range อย่างใดอย่างหนึ่ง");
  }
}

/** @param {Record<string, unknown>} migration */
export function logExplicitSourceIds(migration, profileKey) {
  if (!hasExplicitSourceIds(migration)) return;
  const ids = normalizeSourceIdsArray(migration.sourceIds);
  const meta = SOURCE_IDS_PK_PROFILES[profileKey];
  const pk = meta?.pkLabel ?? "PK";
  const hint = meta?.hint ? ` (${meta.hint})` : "";
  console.error(
    `>>> [${profileKey}] migrateRunMode=by-source-ids (${ids.length} ${pk}${hint}): ${ids.join(", ")}`,
  );
}

/**
 * ปรับ planned rows/chunks สำหรับ progress bar เมื่อ migrate ตาม --source-ids
 *
 * @param {string[] | null | undefined} sourceIds
 * @param {number} batchSize
 * @returns {{ plannedRows: number, plannedChunks: number } | null}
 */
export function plannedProgressForSourceIds(sourceIds, batchSize) {
  if (sourceIds == null || sourceIds.length === 0) return null;
  const plannedRows = sourceIds.length;
  const plannedChunks = Math.max(1, Math.ceil(plannedRows / batchSize));
  return { plannedRows, plannedChunks };
}

/**
 * @param {string} tableKey
 * @param {number} idCount
 * @param {string} idLabel
 * @param {Record<string, unknown>} migration
 */
export function logByIdMigrationRun(tableKey, idCount, idLabel, migration) {
  if (idCount <= 0) return;
  const mode = hasExplicitSourceIds(migration)
    ? "by-source-ids"
    : "repair-from-log";
  console.error(
    `>>> [${tableKey}] migrateRunMode=${mode} (${idCount} ${idLabel})`,
  );
}
