/**
 * อ่าน migration.config*.json + profile (shared + profiles.<name>)
 */

/**
 * @param {string[]} [argv]
 */
export function readConfigPathFromArgv(argv = process.argv) {
  const idx = argv.indexOf("--config");
  if (idx >= 0 && argv[idx + 1]) return String(argv[idx + 1]);
  return "migration.config.local.json";
}

/**
 * @param {string[]} [argv]
 */
export function readProfileFromArgv(argv = process.argv) {
  const idx = argv.indexOf("--profile");
  if (idx >= 0 && argv[idx + 1]) return String(argv[idx + 1]).trim();
  return process.env.MIGRATION_PROFILE?.trim() || null;
}

/**
 * @param {Record<string, unknown>} rawConfig
 * @param {string} profileName
 */
export function resolveRuntimeConfig(rawConfig, profileName) {
  if (!rawConfig?.profiles) return rawConfig;
  const profileConfig = rawConfig.profiles[profileName];
  if (!profileConfig) {
    throw new Error(
      `Profile '${profileName}' not found in config.profiles`,
    );
  }
  const shared = rawConfig.shared ?? {};
  return {
    ...shared,
    ...profileConfig,
    source: { ...(shared.source ?? {}), ...(profileConfig.source ?? {}) },
    target: { ...(shared.target ?? {}), ...(profileConfig.target ?? {}) },
    migration: {
      ...(shared.migration ?? {}),
      ...(profileConfig.migration ?? {}),
    },
    __profileName: profileName,
  };
}

/** ชื่อตาราง MSSQL ดีฟอลต์ต่อ profile (ตรงกับ migrate-from-mssql.mjs แต่ละตัว) */
export const DEFAULT_MSSQL_SOURCE_TABLE = {
  patient_info: "patient_info",
  appointment: "schedule",
  appointment_reschedules: "SCHEDULE_LOG",
  examination: "examination",
  billing: "billing",
  examination_general: "examination_general",
  exam_recommend_birads45: "EXAM_Recommend_BIRADS45",
  pacs_sync_info: "pacs_sync_info",
  procedure: "biopsy",
  ultrasound: "ultrasound",
  mam: "mammogram",
  mam_cal: "mammogram_cal",
  mam_mass: "mammogram_mass",
  ultrasound_cyst: "ultrasound_cyst",
  ultrasound_mass: "ultrasound_mass",
};

/**
 * @param {string} profileName
 * @param {Record<string, unknown> | null | undefined} sourceConfig
 */
export function resolveMssqlSourceObject(profileName, sourceConfig) {
  const schema = sourceConfig?.schema ?? "dbo";
  const table =
    sourceConfig?.table ?? DEFAULT_MSSQL_SOURCE_TABLE[profileName] ?? profileName;
  return {
    schema: String(schema),
    table: String(table),
  };
}
