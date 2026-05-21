/**
 * เติม repair-from-log ให้ migrator แบบ keyset+BY_EXAM_IDS (คล้าย mam-mass)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const jobs = [
  {
    rel: "mam/js-migrate/migrate-from-mssql.mjs",
    key: "mam",
    profile: "mam",
    spec: "REPAIR_SPEC_MAM",
    selectMod: "./mssqlMamSelect.mjs",
    keyset: "MSSQL_MAM_KEYSET_SELECT",
    byIds: "MSSQL_MAM_DETAIL_BY_IDS_SELECT",
    fieldPat: "mammogram",
  },
  {
    rel: "mam-cal/js-migrate/migrate-from-mssql.mjs",
    key: "mam_cal",
    profile: "mam_cal",
    spec: "REPAIR_SPEC_MAM_CAL",
    selectMod: "./mssqlMamCalSelect.mjs",
    keyset: "MSSQL_MAM_CAL_KEYSET_SELECT",
    byIds: "MSSQL_MAM_CAL_BY_EXAM_IDS_SELECT",
    fieldPat: "mammogram_cal",
  },
  {
    rel: "ultrasound-cyst/js-migrate/migrate-from-mssql.mjs",
    key: "ultrasound_cyst",
    profile: "ultrasound_cyst",
    spec: "REPAIR_SPEC_ULTRASOUND_CYST",
    selectMod: "./mssqlUltrasoundCystSelect.mjs",
    keyset: "MSSQL_ULTRASOUND_CYST_KEYSET_SELECT",
    byIds: "MSSQL_ULTRASOUND_CYST_BY_EXAM_IDS_SELECT",
    fieldPat: "ultrasound_cyst",
  },
  {
    rel: "ultrasound-mass/js-migrate/migrate-from-mssql.mjs",
    key: "ultrasound_mass",
    profile: "ultrasound_mass",
    spec: "REPAIR_SPEC_ULTRASOUND_MASS",
    selectMod: "./mssqlUltrasoundMassSelect.mjs",
    keyset: "MSSQL_ULTRASOUND_MASS_KEYSET_SELECT",
    byIds: "MSSQL_ULTRASOUND_MASS_BY_EXAM_IDS_SELECT",
    fieldPat: "ultrasound_mass",
  },
];

for (const j of jobs) {
  const fp = path.join(root, j.rel);
  let c = fs.readFileSync(fp, "utf8");
  if (c.includes("prepareRepairRun")) {
    console.log("skip", j.rel);
    continue;
  }
  if (!c.includes(`mergeMigrationWithCli(config?.migration, "${j.profile}")`)) {
    c = c.replace(
      `resolveRuntimeConfig(rawConfig, "${j.profile}");`,
      `resolveRuntimeConfig(rawConfig, "${j.profile}");\n  const migration = mergeMigrationWithCli(config?.migration, "${j.profile}");`,
    );
    c = c.replace(/config\?\.migration\?\.batchSize/g, "migration.batchSize");
    c = c.replace(
      /config\?\.migration\?\.progressUi/g,
      "migration.progressUi",
    );
    c = c.replace(
      /config\?\.migration\?\.singleLineUi/g,
      "migration.singleLineUi",
    );
    c = c.replace(/config\?\.migration\?\.debugLogs/g, "migration.debugLogs");
    c = c.replace(
      /config\?\.migration\?\.enableCheckpoint/g,
      "migration.enableCheckpoint",
    );
    c = c.replace(
      /config\?\.migration\?\.checkpointDir/g,
      "migration.checkpointDir",
    );
  }

  if (!c.includes(j.byIds)) {
    c = c.replace(
      `import { ${j.keyset} } from "${j.selectMod}";`,
      `import { ${j.byIds}, ${j.keyset} } from "${j.selectMod}";`,
    );
  }
  if (!c.includes("prepareRepairRun")) {
    c = c.replace(
      'import { mergeMigrationWithCli } from "../../shared/js-migrate/mergeMigrationConfig.mjs";',
      `import { mergeMigrationWithCli } from "../../shared/js-migrate/mergeMigrationConfig.mjs";\nimport { fetchMssqlRowsByIds } from "../../shared/js-migrate/fetchMssqlByIds.mjs";\nimport { ${j.spec} } from "../../shared/js-migrate/migrateTableSpecs.mjs";\nimport {\n  prepareRepairRun,\n  repairRunIsDone,\n  repairRunIsEmpty,\n  takeNextRepairBatch,\n} from "../../shared/js-migrate/repairRun.mjs";`,
    );
  }

  const keysetBlock = `const keysetSql = ${j.keyset}.replaceAll(
    "{{sourceObject}}",
    sourceObjectNoLock,
  );`;
  if (!c.includes("detailSqlTemplate")) {
    c = c.replace(
      keysetBlock,
      `${keysetBlock}
  const detailSqlTemplate = ${j.byIds}.replaceAll(
    "{{sourceObject}}",
    sourceObjectNoLock,
  );`,
    );
  }

  const anchor = `>>> [${j.key}]] checkpoint start:`;
  const anchor2 = `>>> [\${KEY}] checkpoint start:`;
  if (c.includes(anchor2) || c.includes(`>>> [${j.key}] checkpoint start`)) {
    console.log("manual loop needed", j.rel);
  } else {
    console.log("WARN no anchor", j.rel);
  }
}

console.log("done — mam/mam-cal/us-* may need manual loop patch (see mam-mass)");
