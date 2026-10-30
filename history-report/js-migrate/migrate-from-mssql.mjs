/**
 * history_report — อ่านรายการ exam ที่ sign แล้วจาก MSSQL (PACS_EXPORT_PDF) ทุกรอบ ไม่ใช้ checkpoint
 * ประกอบ previous_data จากข้อมูลใน Postgres แล้ว INSERT เฉพาะ exam ที่ยังไม่มีประวัติ ไม่แตะแถวเดิมทุกโหมด
 * — เงื่อนไขเลือก exam อยู่ที่ historyReportSql.mjs, รูปแบบ JSON อยู่ที่ historyReportSnapshot.mjs
 *
 * --dry-run = ประกอบ JSON และรายงานขนาด แต่ไม่ INSERT
 * --source-count-cap N = ทำแค่ N exam ล่าสุด (รันทดลอง)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import pg from "pg";
import {
  CHILD_SPECS,
  COUNT_EXAM_TABLE,
  CREATE_CHILD_TABLE,
  CREATE_EXAM_TABLE,
  CREATE_SOURCE_SIGNED_TABLE,
  CREATE_TARGET_TABLE,
  DROP_TEMP_TABLES,
  INDEX_CHILD_TABLE,
  INDEX_HISTORY_TABLE,
  INDEX_SOURCE_SIGNED_TABLE,
  INDEX_TARGET_TABLE,
  INSERT_SOURCE_SIGNED,
  SELECT_CAST_JSON_FIELDS,
  SELECT_COLUMNS,
  SELECT_EXAMS,
  SELECT_HISTORY_BATCH,
  SELECT_TARGET_BATCH,
  createHistorySql,
  fetchChildSql,
  fillChildSql,
  insertBatchSql,
} from "./historyReportSql.mjs";
import {
  APPOINTMENT_FIELDS,
  CASE_OWNER_FIELDS,
  COSIGN_FIELDS,
  INTERVIEW_FIELDS,
  PATIENT_FIELDS,
  PROCEDURE_DATE_FIELDS,
  buildPreviousData,
  resolveSignedAt,
} from "./historyReportSnapshot.mjs";
import {
  createUiState,
  endProgress,
  formatSec,
  renderProgress,
} from "../../shared/js-migrate/progressUi.mjs";
import { parseMigrateCliArgs } from "../../shared/js-migrate/migrateCliArgs.mjs";
import { buildMssqlConfig } from "../../shared/js-migrate/mssqlConnectConfig.mjs";
import {
  fetchAllPacsSignedMamUsExamIds,
  pacsExportTableNoLock,
} from "../../shared/js-migrate/pacsExportSign.mjs";
import {
  readProfileFromArgv,
  resolveRuntimeConfig,
} from "../../shared/js-migrate/resolveMigrationConfig.mjs";
import { createChunkResultsLogger } from "../../shared/js-migrate/chunkResultsLog.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = "history_report";
const PG_TIMESTAMP_OID = 1114;
const PG_DATE_OID = 1082;
const SOURCE_IDS_PER_INSERT = 50000;
const REQUIRED_TARGET_COLUMNS = [
  "examination_general",
  "previous_data",
  "json_version",
  "date_created",
];

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

/**
 * ให้ค่าตรงกับที่ Directus ส่ง — timestamp ไม่มี tz: "2026-10-14T08:04:14", date: "2000-07-06"
 * ที่เหลือ default ของ pg ตรงอยู่แล้ว (numeric = string, real = number, timestamptz = Date -> ...Z)
 */
function directusLikeTypes() {
  const types = new pg.TypeOverrides();
  types.setTypeParser(PG_TIMESTAMP_OID, (v) => v.slice(0, 19).replace(" ", "T"));
  types.setTypeParser(PG_DATE_OID, (v) => v);
  return types;
}

/** key เป็น string เสมอ — pg คืน bigint เป็น string แต่ integer เป็น number เทียบข้ามตารางแล้วไม่เจอเงียบ ๆ */
function groupBy(rows, field) {
  const out = new Map();
  for (const row of rows) {
    const key = String(row[field]);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(row);
  }
  return out;
}

function indexById(rows) {
  return new Map(rows.map((r) => [String(r.id), r]));
}

function distinct(values) {
  return [...new Set(values.filter((v) => v != null))];
}

/** cast-json ของ Directus: string ที่ parse ไม่ได้ส่งคืนค่าเดิม */
function applyCastJson(rows, fields) {
  if (!fields) return;
  for (const row of rows) {
    for (const field of fields) {
      if (typeof row[field] !== "string") continue;
      try {
        row[field] = JSON.parse(row[field]);
      } catch {
        // ค่าเดิม
      }
    }
  }
}

/** ปิด MSSQL ทันทีที่อ่านเสร็จ — ช่วงประกอบ JSON ใช้เวลานานและไม่ต้องใช้ต้นทางอีก */
async function loadSourceSigned(client, source) {
  const pool = await sql.connect(buildMssqlConfig(source));
  let examIds;
  try {
    examIds = await fetchAllPacsSignedMamUsExamIds(pool, {
      pacsTableNoLock: pacsExportTableNoLock(source),
    });
  } finally {
    await pool.close();
  }
  await client.query(CREATE_SOURCE_SIGNED_TABLE);
  for (let i = 0; i < examIds.length; i += SOURCE_IDS_PER_INSERT) {
    await client.query(INSERT_SOURCE_SIGNED, [
      examIds.slice(i, i + SOURCE_IDS_PER_INSERT),
    ]);
  }
  for (const q of INDEX_SOURCE_SIGNED_TABLE) await client.query(q);
}

async function loadColumns(client) {
  const tables = [
    ...CHILD_SPECS.map((s) => s.table),
    "examination",
    "history_report",
    "patient_info",
    "appointment",
    "directus_users",
  ];
  const { rows } = await client.query(SELECT_COLUMNS, [tables]);
  const columns = new Map();
  for (const r of rows) {
    if (!columns.has(r.table_name)) columns.set(r.table_name, new Map());
    columns.get(r.table_name).set(r.column_name, r.udt_name);
  }
  return columns;
}

function assertTargetTable(columns) {
  const target = columns.get("history_report");
  if (!target) {
    throw new Error(
      `[${KEY}] ไม่พบตาราง public.history_report — ต้องสร้าง collection ใน Directus ของ DB นี้ก่อน`,
    );
  }
  const missing = REQUIRED_TARGET_COLUMNS.filter((c) => !target.has(c));
  if (missing.length > 0) {
    throw new Error(
      `[${KEY}] public.history_report ไม่มีคอลัมน์: ${missing.join(", ")}`,
    );
  }
}

async function loadCastJson(client, columns) {
  const { rows } = await client.query(SELECT_CAST_JSON_FIELDS, [[...columns.keys()]]);
  const castJson = new Map();
  for (const r of rows) {
    if (!castJson.has(r.collection)) castJson.set(r.collection, []);
    castJson.get(r.collection).push(r.field);
  }
  return castJson;
}

/** field ที่ baseline บางชุดยังไม่มี (short_note, referring_md) เลือกเฉพาะคอลัมน์ที่มีจริง */
async function selectByIds(client, columns, table, fields, idType, ids) {
  if (ids.length === 0) return [];
  const existing = fields.filter((f) => columns.get(table)?.has(f));
  const cols = distinct(["id", ...existing]).map((f) => `"${f}"`).join(", ");
  const { rows } = await client.query(
    `SELECT ${cols} FROM public."${table}" WHERE id = ANY ($1::${idType}[])`,
    [ids],
  );
  return rows;
}

async function loadBatch(client, { columns, castJson }, examIds) {
  const { rows: exams } = await client.query(SELECT_EXAMS, [examIds]);
  applyCastJson(exams, castJson.get("examination"));

  const childRows = new Map();
  for (const spec of CHILD_SPECS) {
    if (!columns.has(spec.table)) {
      childRows.set(spec.key, []);
      continue;
    }
    const parentIds = spec.parent
      ? childRows.get(spec.parent).map((r) => r.id)
      : examIds;
    const { rows } = await client.query(fetchChildSql(spec), [spec.key, parentIds]);
    applyCastJson(rows, castJson.get(spec.table));
    childRows.set(spec.key, rows);
  }

  const patients = await selectByIds(
    client,
    columns,
    "patient_info",
    PATIENT_FIELDS,
    "bigint",
    distinct(exams.map((e) => e.patient)),
  );
  const appointments = await selectByIds(
    client,
    columns,
    "appointment",
    APPOINTMENT_FIELDS,
    "bigint",
    distinct(exams.map((e) => e.appointment)),
  );
  applyCastJson(appointments, castJson.get("appointment"));
  const users = await selectByIds(
    client,
    columns,
    "directus_users",
    [...COSIGN_FIELDS, ...CASE_OWNER_FIELDS],
    "uuid",
    distinct([
      ...exams.map((e) => e.case_owner_doctor),
      ...childRows.get("examination_general").map((g) => g.cosign),
    ]),
  );
  const { rows: historyRows } = await client.query(SELECT_HISTORY_BATCH, [
    distinct(exams.map((e) => e.patient)),
  ]);

  const examChildSpecs = CHILD_SPECS.filter((s) => !s.parent);
  const grouped = new Map(
    examChildSpecs.map((s) => [s.key, groupBy(childRows.get(s.key), s.fk)]),
  );
  const spotShapes = groupBy(childRows.get("spot_shapes"), "spot");
  const patientById = indexById(patients);
  const appointmentById = indexById(appointments);
  const userById = indexById(users);
  const historyByPatient = groupBy(historyRows, "patient");

  return new Map(
    exams.map((exam) => [
      String(exam.id),
      buildPreviousData({
        exam,
        children: Object.fromEntries(
          examChildSpecs.map((s) => [
            s.key,
            grouped.get(s.key).get(String(exam.id)) ?? [],
          ]),
        ),
        spotShapes,
        patient: patientById.get(String(exam.patient)),
        appointment: appointmentById.get(String(exam.appointment)),
        users: userById,
        historyRows: historyByPatient.get(String(exam.patient)) ?? [],
      }),
    ]),
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
      `>>> [${KEY}] repair-from-log: ข้าม — step นี้เลือก exam ที่ยังไม่มีประวัติใหม่ทุกรอบ ไม่มี id ให้ซ่อม`,
    );
    return;
  }
  // ต้องหยุด ไม่ใช่เตือนแล้วทำต่อ: npm run ที่ลืม -- ทำให้ค่า cap กลายเป็น --source-index-range
  // ถ้าทำต่อจะ insert ทั้งชุดทั้งที่ตั้งใจทดลองไม่กี่แถว
  if (
    cli.sourceIndexFrom != null ||
    cli.sourceIndexTo != null ||
    cli.hasSourceKeyCli ||
    cli.hasSourceIdsCli
  ) {
    console.error(
      `>>> [${KEY}] หมายเหตุ: ข้าม ไม่เขียนอะไร — step นี้ไม่รับ --source-index-* / --source-key-* / --source-ids จำกัดจำนวนด้วย: npm run migrate:history_report -- --source-count-cap 100`,
    );
    return;
  }

  const migration = config.migration ?? {};
  const batchSize = Math.max(
    100,
    Math.min(5000, Number(migration.batchSize ?? 2000)),
  );
  const progressEnabled = migration.progressUi !== false;
  const dryRun = isDryRun();
  const cap = cli.sourceCountCap ?? null;
  const uiState = createUiState();

  const logsDir = path.resolve(__dirname, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, `migrate-${nowStamp()}.json`);
  const runLog = {
    startedAt: new Date().toISOString(),
    status: "running",
    dryRun,
    batchSize,
    cap,
    sourceSignedExams: 0,
    notInPostgres: 0,
    noMamUsReport: 0,
    noExaminationGeneral: 0,
    alreadyHasHistory: 0,
    pending: 0,
    rowsInserted: 0,
    snapshotBytes: 0,
    largestSnapshotBytes: 0,
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
    types: directusLikeTypes(),
  });
  await client.connect();
  try {
    console.error(
      `>>> [${KEY}] target: ${config.target.postgresDatabase} public.history_report (batchSize=${batchSize}${cap != null ? `, cap=${cap}` : ""}${dryRun ? ", DRY RUN" : ""})`,
    );
    console.error(
      `>>> [${KEY}] insert เฉพาะ exam ที่ยังไม่มีประวัติ ไม่แตะแถวเดิม — ไม่ใช้ checkpoint / migrateRowMode`,
    );

    const columns = await loadColumns(client);
    assertTargetTable(columns);
    for (const spec of CHILD_SPECS) {
      if (!columns.has(spec.table)) {
        console.error(`>>> [${KEY}] คำเตือน: ไม่มีตาราง ${spec.table} — ${spec.key} เป็น [] ทุกแถว`);
      }
    }
    const castJson = await loadCastJson(client, columns);
    await client.query(DROP_TEMP_TABLES);

    const t0 = Date.now();
    await loadSourceSigned(client, config.source);
    await client.query(CREATE_EXAM_TABLE);
    const counts = (await client.query(COUNT_EXAM_TABLE)).rows[0];
    await client.query(CREATE_TARGET_TABLE, [cap]);
    for (const q of INDEX_TARGET_TABLE) await client.query(q);
    await client.query(CREATE_CHILD_TABLE);
    for (const spec of CHILD_SPECS) {
      if (columns.has(spec.table)) await client.query(fillChildSql(spec));
    }
    for (const q of INDEX_CHILD_TABLE) await client.query(q);
    await client.query(createHistorySql([...INTERVIEW_FIELDS, ...PROCEDURE_DATE_FIELDS]));
    for (const q of INDEX_HISTORY_TABLE) await client.query(q);

    const total = (await client.query("SELECT count(*)::int AS n FROM hr_target"))
      .rows[0].n;
    runLog.sourceSignedExams = counts.source_signed;
    runLog.notInPostgres = counts.source_signed - counts.in_postgres;
    runLog.noMamUsReport = counts.no_report;
    runLog.noExaminationGeneral = counts.no_general;
    runLog.alreadyHasHistory = counts.has_history;
    runLog.pending = total;
    console.error(
      `>>> [${KEY}] plan ${formatSec(Date.now() - t0)}: ต้นทาง sign แล้ว ${counts.source_signed} | ยังไม่มีใน Postgres ${runLog.notInPostgres} | ไม่มี mam/us ${counts.no_report} | ไม่มี examination_general ${counts.no_general} | มีประวัติแล้ว ${counts.has_history} | จะสร้าง ${total}`,
    );

    const insertSql = insertBatchSql(columns.get("history_report"));
    const plannedChunks = Math.ceil(total / batchSize);
    const startedAt = Date.now();
    let afterId = "0";
    let done = 0;
    let chunkIndex = 0;
    while (true) {
      const chunkStartedAt = Date.now();
      const { rows: targets } = await client.query(SELECT_TARGET_BATCH, [
        afterId,
        batchSize,
      ]);
      if (targets.length === 0) break;

      const lastId = String(targets[targets.length - 1].exam_id);
      let chunkBytes = 0;
      try {
        const snapshots = await loadBatch(
          client,
          { columns, castJson },
          targets.map((t) => t.exam_id),
        );
        const generalIds = [];
        const payloads = [];
        const signedAts = [];
        for (const target of targets) {
          const previousData = snapshots.get(String(target.exam_id));
          const json = JSON.stringify(previousData);
          const bytes = Buffer.byteLength(json);
          chunkBytes += bytes;
          runLog.largestSnapshotBytes = Math.max(runLog.largestSnapshotBytes, bytes);
          generalIds.push(target.general_id);
          payloads.push(json);
          signedAts.push(resolveSignedAt(previousData));
        }
        if (!dryRun) {
          await client.query(insertSql, [generalIds, payloads, signedAts]);
          runLog.rowsInserted += targets.length;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        chunkLog.recordFailure({
          chunkIndex: chunkIndex + 1,
          afterExamId: afterId,
          chunkTotalMs: Date.now() - chunkStartedAt,
          error: message,
        });
        throw new Error(
          `[${KEY}] failed chunk ${chunkIndex + 1} (exam id > ${afterId}): ${message}`,
        );
      }

      chunkIndex += 1;
      done += targets.length;
      runLog.snapshotBytes += chunkBytes;
      chunkLog.record({
        chunkIndex,
        status: "success",
        rowCount: targets.length,
        firstAfterExamId: afterId,
        lastExamId: lastId,
        snapshotBytes: chunkBytes,
        chunkTotalMs: Date.now() - chunkStartedAt,
      });
      if (progressEnabled) {
        renderProgress(done, total, startedAt, chunkIndex, plannedChunks, uiState);
      }
      afterId = lastId;
      if (targets.length < batchSize) break;
    }
    if (progressEnabled) endProgress(uiState);

    const avgKb = done > 0 ? (runLog.snapshotBytes / done / 1024).toFixed(1) : "0";
    const totalMb = (runLog.snapshotBytes / 1024 / 1024).toFixed(1);
    console.error(
      `>>> [${KEY}] done, ${dryRun ? "DRY RUN จะ insert" : "inserted"} ${done} แถว (previous_data เฉลี่ย ${avgKb} KB รวม ${totalMb} MB ก่อนบีบอัด) ${formatSec(Date.now() - startedAt)}`,
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
