import {
  logMigrationRunMode,
  logSourceNumericKeyRange,
  migrateCliOverridesFromArgv,
  parseMigrateCliArgs,
} from "./migrateCliArgs.mjs";
import { assertMigrateRunModeSupported } from "./repairFromLog.mjs";
import { REPAIR_SPEC_BY_PROFILE } from "./migrateTableSpecs.mjs";
import { assertSourceKeyRangeSupported } from "./sourceKeyRangeSupport.mjs";

/**
 * รวม config.migration กับ CLI และตรวจว่า repair-from-log ใช้ได้กับ profile นี้หรือไม่
 *
 * @param {Record<string, unknown> | undefined} base
 * @param {string} profileKey ชื่อ profile / ตาราง เช่น mam_mass, patient_info
 */
export function mergeMigrationWithCli(base, profileKey) {
  const parsed = parseMigrateCliArgs(process.argv);
  const cli = migrateCliOverridesFromArgv(process.argv);
  const repairSpec = REPAIR_SPEC_BY_PROFILE[profileKey] ?? null;
  assertMigrateRunModeSupported(cli, {
    tableLabel: profileKey,
    repairSpec,
  });
  const merged = { ...(base ?? {}), ...cli };
  assertSourceKeyRangeSupported(profileKey, merged, parsed.hasSourceKeyCli);
  logMigrationRunMode(merged, profileKey);
  logSourceNumericKeyRange(merged, profileKey);
  return merged;
}
