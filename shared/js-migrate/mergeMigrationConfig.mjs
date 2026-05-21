import {
  logMigrationRunMode,
  migrateCliOverridesFromArgv,
} from "./migrateCliArgs.mjs";
import { assertMigrateRunModeSupported } from "./repairFromLog.mjs";
import { REPAIR_SPEC_BY_PROFILE } from "./migrateTableSpecs.mjs";

/**
 * รวม config.migration กับ CLI และตรวจว่า repair-from-log ใช้ได้กับ profile นี้หรือไม่
 *
 * @param {Record<string, unknown> | undefined} base
 * @param {string} profileKey ชื่อ profile / ตาราง เช่น mam_mass, patient_info
 */
export function mergeMigrationWithCli(base, profileKey) {
  const cli = migrateCliOverridesFromArgv(process.argv);
  const repairSpec = REPAIR_SPEC_BY_PROFILE[profileKey] ?? null;
  assertMigrateRunModeSupported(cli, {
    tableLabel: profileKey,
    repairSpec,
  });
  const merged = { ...(base ?? {}), ...cli };
  logMigrationRunMode(merged, profileKey);
  return merged;
}
