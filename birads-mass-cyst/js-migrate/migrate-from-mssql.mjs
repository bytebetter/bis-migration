/**
 * birads_mass_cyst — ไม่อ่าน MSSQL (ชื่อไฟล์ตามที่ run-migrate-table-cli.mjs เรียก)
 * คำนวณ appointment.us_mass + assessment_birads_des จากข้อมูลใน Postgres ใหม่ทุกรอบ แล้ว UPDATE
 * เฉพาะแถวที่ค่าเปลี่ยน — เงื่อนไขเลือก exam อยู่ที่ biradsMassCystSql.mjs
 *
 * --dry-run = คำนวณและนับแถวที่จะเปลี่ยน แต่ ROLLBACK ทุก batch
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  COUNT_TEMP_TABLES,
  CREATE_PICK_TABLE,
  CREATE_SIGNED_EXAM_TABLE,
  DROP_TEMP_TABLES,
  INDEX_PICK_TABLE,
  INDEX_SIGNED_EXAM_TABLE,
  MIGRATED_APPOINTMENT_COUNTS,
  UPDATE_BATCH,
} from "./biradsMassCystSql.mjs";
import {
  createUiState,
  endProgress,
  formatSec,
  renderProgress,
} from "../../shared/js-migrate/progressUi.mjs";
import { parseMigrateCliArgs } from "../../shared/js-migrate/migrateCliArgs.mjs";
import {
  readProfileFromArgv,
  resolveRuntimeConfig,
} from "../../shared/js-migrate/resolveMigrationConfig.mjs";
import { createChunkResultsLogger } from "../../shared/js-migrate/chunkResultsLog.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = "birads_mass_cyst";

function getConfigPath() {
  const idx = process.argv.indexOf("--config");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return "../../migration.config.local.json";
}

function nowStamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

/** npm กลืน --dry-run ที่ไม่มี -- นำหน้าแล้ว set npm_config_dry_run แทน */
function isDryRun() {
  return (
    process.argv.includes("--dry-run") ||
    String(process.env.npm_config_dry_run ?? "").trim().toLowerCase() === "true"
  );
}

async function main() {
  const configPath = path.resolve(process.cwd(), getConfigPath());
  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const profile = readProfileFromArgv() ?? KEY;
  // step นี้ไม่มีค่าเฉพาะ profile — ไม่มี profile ใน config ก็ใช้ shared
  const config = rawConfig?.profiles
    ? resolveRuntimeConfig(
        { ...rawConfig, profiles: { [profile]: {}, ...rawConfig.profiles } },
        profile,
      )
    : rawConfig;

  const cli = parseMigrateCliArgs(process.argv);
  if (cli.migrateRunMode === "repair-from-log") {
    console.error(
      `>>> [${KEY}] repair-from-log: ข้าม — step นี้คำนวณใหม่ทั้งชุดทุกรอบ ไม่มี id ให้ซ่อม`,
    );
    return;
  }
  if (
    cli.sourceIndexFrom != null ||
    cli.sourceIndexTo != null ||
    cli.sourceCountCap != null ||
    cli.hasSourceKeyCli ||
    cli.hasSourceIdsCli
  ) {
    console.error(
      `>>> [${KEY}] ไม่ใช้ --source-index-* / --source-key-* / --source-ids / --source-count-cap — คำนวณทุก appointment ที่ migrate มา`,
    );
  }

  const migration = config.migration ?? {};
  const batchSize = Math.max(
    100,
    Math.min(20000, Number(migration.batchSize ?? 2000)),
  );
  const progressEnabled = migration.progressUi !== false;
  const dryRun = isDryRun();
  const uiState = createUiState();

  const logsDir = path.resolve(__dirname, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, `migrate-${nowStamp()}.json`);
  const runLog = {
    startedAt: new Date().toISOString(),
    status: "running",
    dryRun,
    batchSize,
    migratedAppointments: 0,
    noPatientInfo: 0,
    noAppointmentDatetime: 0,
    signedUsExams: 0,
    withPriorSignedUs: 0,
    withoutPriorSignedUs: 0,
    rowsUpdated: 0,
    rowsUnchanged: 0,
    error: null,
  };
  const chunkLog = createChunkResultsLogger(migration);

  // temp table อยู่ใน session เดียว — ใช้ client เดียวตลอดรอบ
  const client = new pg.Client({
    host: config.target.postgresHost,
    port: Number(config.target.postgresPort ?? 5432),
    user: config.target.postgresUser,
    password: config.target.postgresPassword,
    database: config.target.postgresDatabase ?? "bisinfo_dev_clone",
  });
  await client.connect();
  try {
    console.error(
      `>>> [${KEY}] target: ${config.target.postgresDatabase} public.appointment.us_mass + assessment_birads_des (batchSize=${batchSize}${dryRun ? ", DRY RUN" : ""})`,
    );
    console.error(
      `>>> [${KEY}] คำนวณใหม่ทุกรอบ UPDATE เฉพาะแถวที่เปลี่ยน — ไม่ใช้ checkpoint / migrateRowMode`,
    );
    // timestamptz ใน us_mass ออกเป็น UTC เหมือนที่ Directus ส่ง
    await client.query("SET TIME ZONE 'UTC'");
    await client.query(DROP_TEMP_TABLES);

    let t0 = Date.now();
    await client.query(CREATE_SIGNED_EXAM_TABLE);
    for (const q of INDEX_SIGNED_EXAM_TABLE) await client.query(q);
    await client.query(CREATE_PICK_TABLE);
    for (const q of INDEX_PICK_TABLE) await client.query(q);
    const counts = (await client.query(COUNT_TEMP_TABLES)).rows[0];
    const appt = (await client.query(MIGRATED_APPOINTMENT_COUNTS)).rows[0];
    runLog.signedUsExams = counts.signed_exams;
    runLog.withPriorSignedUs = counts.picked;
    runLog.migratedAppointments = appt.migrated;
    runLog.noPatientInfo = appt.no_patient_info;
    runLog.noAppointmentDatetime = appt.no_appointment_datetime;
    runLog.withoutPriorSignedUs =
      appt.migrated -
      appt.no_patient_info -
      appt.no_appointment_datetime -
      counts.picked;
    console.error(
      `>>> [${KEY}] plan ${formatSec(Date.now() - t0)}: appointment migrate มา ${appt.migrated} | มีผล US sign ก่อนวันนัด ${counts.picked} | ไม่มี ${runLog.withoutPriorSignedUs} | ไม่มี patient_info ${appt.no_patient_info} | ไม่มีวันนัด ${appt.no_appointment_datetime} (exam US sign ทั้งหมด ${counts.signed_exams})`,
    );

    const total = counts.picked;
    const plannedChunks = Math.ceil(total / batchSize);
    const startedAt = Date.now();
    let afterId = "0";
    let done = 0;
    let chunkIndex = 0;
    while (true) {
      const chunkStartedAt = Date.now();
      let res;
      try {
        if (dryRun) await client.query("BEGIN");
        res = await client.query(UPDATE_BATCH, [afterId, batchSize]);
        if (dryRun) await client.query("ROLLBACK");
      } catch (err) {
        if (dryRun) await client.query("ROLLBACK").catch(() => {});
        const message = err instanceof Error ? err.message : String(err);
        chunkLog.recordFailure({
          chunkIndex: chunkIndex + 1,
          afterAppointmentId: afterId,
          chunkTotalMs: Date.now() - chunkStartedAt,
          error: message,
        });
        throw new Error(
          `[${KEY}] failed chunk ${chunkIndex + 1} (appointment id > ${afterId}): ${message}`,
        );
      }
      const { batch_rows: batchRows, last_id: lastId, rows_updated: rowsUpdated } =
        res.rows[0];
      if (batchRows === 0) break;

      chunkIndex += 1;
      done += batchRows;
      runLog.rowsUpdated += rowsUpdated;
      chunkLog.record({
        chunkIndex,
        status: "success",
        rowCount: batchRows,
        firstAfterAppointmentId: afterId,
        lastAppointmentId: lastId,
        rowsUpdated,
        chunkTotalMs: Date.now() - chunkStartedAt,
      });
      if (progressEnabled) {
        renderProgress(done, total, startedAt, chunkIndex, plannedChunks, uiState);
      }
      afterId = lastId;
      if (batchRows < batchSize) break;
    }
    if (progressEnabled) endProgress(uiState);

    runLog.rowsUnchanged = done - runLog.rowsUpdated;
    console.error(
      `>>> [${KEY}] ${dryRun ? "DRY RUN จะ update" : "updated"} ${runLog.rowsUpdated} แถว (ค่าเดิมตรงแล้ว ${runLog.rowsUnchanged}) ${formatSec(Date.now() - startedAt)}`,
    );
    runLog.status = "success";
  } catch (err) {
    runLog.status = "failed";
    runLog.error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    await client.end();
    runLog.finishedAt = new Date().toISOString();
    chunkLog.attachTo(runLog);
    fs.writeFileSync(logPath, `${JSON.stringify(runLog, null, 2)}\n`, "utf8");
    console.error(`>>> migration log saved: ${logPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
