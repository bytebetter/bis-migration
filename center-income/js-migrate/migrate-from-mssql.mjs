/**
 * center_income — dbo.income + dbo.income2 (MSSQL) -> public.center_income (Postgres/Directus)
 *
 * รายรับของศูนย์ที่ไม่ใช่ค่าตรวจ (บริจาค / ขอ Copy CD) หลักหมื่นแถว ไม่มี CreatedDate — เดินครบทุกแถวทุกรอบ ไม่ใช้ checkpoint
 * เทียบด้วย old_db_id ("income:ID" / "income2:ID"): ไม่มีปลายทาง = insert, มีแล้ว = ไม่ทับข้อมูล
 * แต่เติม patient_info ที่ยังว่าง (insert-only) หรือเขียนทับให้ตรงต้นทาง (overwrite) — รันซ้ำได้ ไม่เกิดแถวซ้ำ
 * แถว income2 ที่ income มีซ้ำทั้งแถวถูกตัดทิ้งตั้งแต่ฝั่ง MSSQL (ดู mssqlCenterIncomeSelect.mjs)
 * กติกาแปลงค่าดู centerIncomeMapping.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import pg from "pg";
import {
  buildCenterIncomeBreakdownSql,
  buildCenterIncomeByKeysSql,
  buildCenterIncomeCountSql,
  buildCenterIncomePageSql,
} from "./mssqlCenterIncomeSelect.mjs";
import { ensureCenterIncomePipelineDdl } from "./centerIncomePgDdl.mjs";
import {
  CENTER_INCOME_MOBILE_LOCATION,
  centerIncomeRowKey,
  normalizeCenterIncomeMssqlRow,
  resetCenterIncomeTargetColumnCache,
  runCenterIncomeChunkPostLoad,
} from "./centerIncomeMapping.mjs";
import {
  createUiState,
  endProgress,
  formatSec,
  renderProgress,
  writeOutLine,
} from "../../shared/js-migrate/progressUi.mjs";
import { mergeMigrationWithCli } from "../../shared/js-migrate/mergeMigrationConfig.mjs";
import { buildMssqlConfig } from "../../shared/js-migrate/mssqlConnectConfig.mjs";
import {
  readProfileFromArgv,
  resolveMssqlSourceObject,
  resolveRuntimeConfig,
} from "../../shared/js-migrate/resolveMigrationConfig.mjs";
import { resolveBatchSize } from "../../shared/js-migrate/resolveBatchSize.mjs";
import {
  applySourceIndexToMigrateJob,
  capAdvanceToMigratePlan,
  plannedRowsForPageSize,
  resolvePageSize,
  rowsDoneInMigrateRun,
  shouldStopMigratePagination,
} from "../../shared/js-migrate/sourceIndexRange.mjs";
import { prepareMigrateRowPlan } from "../../shared/js-migrate/sourceCountSnapshot.mjs";
import { fetchMssqlRowsByIds } from "../../shared/js-migrate/fetchMssqlByIds.mjs";
import { REPAIR_SPEC_CENTER_INCOME } from "../../shared/js-migrate/migrateTableSpecs.mjs";
import {
  explicitIdsProgressPlan,
  finishRepairRunSummary,
  noteRepairBatchFetch,
  prepareRepairRun,
  repairRunIsDone,
  repairRunIsEmpty,
  takeNextRepairBatch,
} from "../../shared/js-migrate/repairRun.mjs";
import { createChunkResultsLogger } from "../../shared/js-migrate/chunkResultsLog.mjs";
import {
  buildFieldIssueLogPayload,
  createFieldIssueAccumulator,
  mergeFieldIssueChunk,
  writeFieldIssueLogFile,
} from "../../shared/js-migrate/fieldIssueLog.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = "center_income";

/** ตัวอย่างแถวที่ไม่มีคีย์ที่เก็บลง run log (ไม่ต้องเก็บทุกแถว) */
const SKIPPED_SAMPLE_MAX = 50;

function getConfigPath() {
  const idx = process.argv.indexOf("--config");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return "../../migration.config.local.json";
}

function nowStamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

/**
 * คีย์ของแถวที่ดึงได้ → คีย์ตามที่ขอมา (ขอ Income:10 ได้แถว income:10)
 * ใช้กับ noteRepairBatchFetch ไม่ให้นับแถวที่เจอเป็น "ไม่พบในต้นทาง"
 * @param {string[]} requested
 */
function rowKeyMatchingRequested(requested) {
  const byLower = new Map(requested.map((k) => [String(k).toLowerCase(), String(k)]));
  return (row) => {
    const key = centerIncomeRowKey(row) ?? "";
    return byLower.get(key.toLowerCase()) ?? key;
  };
}

async function main() {
  const configPath = path.resolve(process.cwd(), getConfigPath());
  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const profile = readProfileFromArgv() ?? KEY;
  const config = resolveRuntimeConfig(rawConfig, profile);
  if (config.__profileName) {
    console.error(`>>> using config profile: ${config.__profileName}`);
  }
  const migration = mergeMigrationWithCli(config?.migration, KEY);
  const migrateRowMode =
    migration.migrateRowMode === "insert-only" ? "insert-only" : "overwrite";

  // ชื่อตาราง income / income2 ตายตัวใน mssqlCenterIncomeSelect.mjs — จาก config ใช้แค่ schema
  const { schema: sourceSchema } = resolveMssqlSourceObject(KEY, config.source);

  const batchSize = resolveBatchSize(migration, {}, { floor: 100 });
  const progressEnabled = migration.progressUi !== false;
  const singleLineUi = migration.singleLineUi !== false;
  const debugLogs = migration.debugLogs === true;
  const uiState = createUiState();

  const logsDir = path.resolve(__dirname, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, `migrate-${nowStamp()}.json`);
  const runLog = {
    startedAt: new Date().toISOString(),
    status: "running",
    sourceObject: `${sourceSchema}.income + ${sourceSchema}.income2`,
    migrateRowMode,
    batchSize,
    /** income / income2 ทั้งหมด และ income2 ที่เหลือหลังตัดแถวที่ income มีซ้ำ */
    sourceBreakdown: null,
    rowsRead: 0,
    rowsLoadedToStaging: 0,
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsRelationFilled: 0,
    rowsSkippedExisting: 0,
    duplicateKeys: 0,
    /** Copy CD (Income_type 0 + Donate_type 0) / บริจาค — นับจากแถวที่อ่านรอบนี้ */
    copyCdRows: 0,
    donationRows: 0,
    /** แถวที่มี PID ให้ผูก / ผูกได้ */
    patientWanted: 0,
    patientResolved: 0,
    skippedNoKey: 0,
    /** @type {object[]} */
    skippedNoKeySample: [],
    /** คีย์ทั้ง chunk ที่ล้ม — repair-from-log อ่านจากตรงนี้ (คีย์เป็นข้อความ ขยายช่วงแบบเลขไม่ได้) */
    /** @type {string[]} */
    failedKeys: [],
    targetRowCount: null,
    fieldIssueLogPath: null,
    error: null,
  };
  const chunkLog = createChunkResultsLogger(migration);

  const pgPool = new pg.Pool({
    host: config.target.postgresHost,
    port: Number(config.target.postgresPort ?? 5432),
    user: config.target.postgresUser,
    password: config.target.postgresPassword,
    database: config.target.postgresDatabase ?? "bisinfo_dev_clone",
    max: 2,
  });

  const pageSql = buildCenterIncomePageSql(sourceSchema);
  const byKeysSqlTemplate = buildCenterIncomeByKeysSql(sourceSchema);

  const pool = await sql.connect(buildMssqlConfig(config.source));
  try {
    const client = await pgPool.connect();
    try {
      resetCenterIncomeTargetColumnCache();
      await ensureCenterIncomePipelineDdl(client);
      console.error(`>>> [${KEY}] source: ${runLog.sourceObject}`);
      console.error(
        `>>> [${KEY}] target: ${config.target.postgresDatabase} public.center_income (เทียบด้วย old_db_id "income:ID" / "income2:ID", batchSize=${batchSize})`,
      );
      console.error(
        migrateRowMode === "insert-only"
          ? `>>> [${KEY}] migrateRowMode=insert-only: insert เฉพาะคีย์ใหม่ + เติม patient_info ที่ยังว่างของแถวเดิม (ไม่ทับข้อมูลที่แก้ในระบบใหม่)`
          : `>>> [${KEY}] migrateRowMode=overwrite: insert คีย์ใหม่ + เขียนทับแถวเดิมให้ตรงต้นทาง (ไม่แตะ status)`,
      );
      console.error(
        `>>> [${KEY}] full pass: ไล่ income2 แล้ว income ตาม Income_ID ทุกรอบ (ไม่ใช้ checkpoint — รันซ้ำไม่เกิดแถวซ้ำ); Mobile = 1 → location ${CENTER_INCOME_MOBILE_LOCATION}`,
      );

      const idx = applySourceIndexToMigrateJob({
        key: KEY,
        migrationConfig: migration,
        checkpointEnabled: false,
        offset: 0,
        useMssqlKeyset: false,
      });
      let offset = idx.offset;

      /** นับไว้ทำแผน/progress เท่านั้น — นับไม่ได้ก็ยังอ่านต้นทางจนหมดได้ */
      let sourceRowCountTotal = null;
      try {
        const countRes = await pool
          .request()
          .query(buildCenterIncomeCountSql(sourceSchema));
        sourceRowCountTotal = Number(countRes.recordset?.[0]?.total ?? 0);
        const bd = await pool
          .request()
          .query(buildCenterIncomeBreakdownSql(sourceSchema));
        const b = bd.recordset?.[0];
        if (b) {
          runLog.sourceBreakdown = {
            income: Number(b.main_total ?? 0),
            income2: Number(b.archive_total ?? 0),
            income2Kept: Number(b.archive_kept ?? 0),
            income2DuplicateOfIncome:
              Number(b.archive_total ?? 0) - Number(b.archive_kept ?? 0),
          };
          console.error(
            `>>> [${KEY}] ต้นทาง: income ${runLog.sourceBreakdown.income} แถว, income2 ${runLog.sourceBreakdown.income2} แถว` +
              ` (ซ้ำกับ income ${runLog.sourceBreakdown.income2DuplicateOfIncome} → ตัดทิ้ง, เหลือ ${runLog.sourceBreakdown.income2Kept})` +
              ` → อ่านทั้งหมด ${sourceRowCountTotal} แถว`,
          );
        }
      } catch (err) {
        console.error(
          `>>> [${KEY}] นับแถวต้นทางไม่สำเร็จ (${err instanceof Error ? err.message : String(err)}) — รันต่อโดยไม่มีแผนจำนวนแถว`,
        );
      }
      let plannedRows = prepareMigrateRowPlan({
        migrationConfig: migration,
        sourceRowCountTotal,
        offset,
        indexLimited: idx.indexLimited,
        sourceIndexFrom: idx.sourceIndexFrom,
        sourceIndexTo: idx.sourceIndexTo,
      });
      let progressTotal = plannedRows ?? null;
      let plannedChunks =
        plannedRows != null && plannedRows > 0
          ? Math.ceil(plannedRows / batchSize)
          : null;
      if (plannedChunks != null) {
        console.error(
          `>>> [${KEY}] plan: ${plannedRows} แถว, ~${plannedChunks} chunks (ต้นทางทั้งหมด ${sourceRowCountTotal})`,
        );
      }

      const fieldIssueAcc = createFieldIssueAccumulator("center_income_key");
      const fieldIssueLogPath = path.join(
        logsDir,
        `migration-field-issues-center_income-${nowStamp()}.json`,
      );

      const repairRun = prepareRepairRun(
        migration,
        logsDir,
        REPAIR_SPEC_CENTER_INCOME,
        batchSize,
      );
      const idPlan = explicitIdsProgressPlan(repairRun, batchSize);
      if (idPlan) {
        plannedRows = idPlan.plannedRows;
        plannedChunks = idPlan.plannedChunks;
        progressTotal = idPlan.plannedRows;
      }
      if (repairRunIsEmpty(repairRun)) {
        runLog.status = "success";
        chunkLog.attachTo(runLog);
        return;
      }

      const startedAt = Date.now();
      const runStartOffset = offset;
      let chunkIndex = 0;
      while (true) {
        const chunkStartedAt = Date.now();
        const rowsDoneThisRun = rowsDoneInMigrateRun(offset, runStartOffset);
        const pageSize = resolvePageSize({
          batchSize,
          total: rowsDoneThisRun,
          plannedRows: plannedRowsForPageSize(
            plannedRows,
            migration,
            idx.indexLimited,
          ),
        });
        if (pageSize <= 0) break;

        /** @type {object[]} */
        let rows = [];
        const fetchStartedAt = Date.now();
        if (repairRun.active) {
          const idBatch = takeNextRepairBatch(repairRun);
          if (!idBatch) break;
          const requested = idBatch.map(String);
          rows = await fetchMssqlRowsByIds(pool, sql, {
            ids: requested,
            detailSqlTemplate: byKeysSqlTemplate,
            idType: "nvarchar",
            nvarcharLength: 64,
          });
          noteRepairBatchFetch(
            repairRun,
            requested,
            rows,
            rowKeyMatchingRequested(requested),
          );
          if (rows.length === 0) {
            if (repairRunIsDone(repairRun)) break;
            continue;
          }
        } else {
          const res = await pool
            .request()
            .input("offset", sql.Int, offset)
            .input("page", sql.Int, pageSize)
            .query(pageSql);
          rows = res.recordset ?? [];
        }
        const fetchMs = Date.now() - fetchStartedAt;
        if (rows.length === 0) break;

        chunkIndex += 1;
        /** @type {object[]} */
        const normalized = [];
        let skipped = 0;
        for (const r of rows) {
          const n = normalizeCenterIncomeMssqlRow(r);
          if (n) {
            normalized.push(n);
            continue;
          }
          skipped += 1;
          if (runLog.skippedNoKeySample.length < SKIPPED_SAMPLE_MAX) {
            runLog.skippedNoKeySample.push({
              income_date: r?.income_date ?? null,
              full_name: r?.full_name ?? null,
              receipt_no: r?.receipt_no ?? null,
            });
          }
        }
        const keys = normalized.map(centerIncomeRowKey);

        let step = "begin";
        /** @type {Awaited<ReturnType<typeof runCenterIncomeChunkPostLoad>>} */
        let postResult;
        try {
          step = "BEGIN";
          await client.query("BEGIN");
          step = "load to staging + resolve patient_info + insert/update center_income";
          postResult = await runCenterIncomeChunkPostLoad(client, normalized, {
            migrateRowMode,
          });
          step = "COMMIT";
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          runLog.failedKeys.push(...keys);
          chunkLog.recordFailure({
            chunkIndex,
            failedAtStep: step,
            rowCount: rows.length,
            rowsFetched: rows.length,
            firstKey: keys[0] ?? null,
            lastKey: keys.length > 0 ? keys[keys.length - 1] : null,
            fetchMs,
            chunkTotalMs: Date.now() - chunkStartedAt,
            error: err instanceof Error ? err.message : String(err),
          });
          throw new Error(
            `[${KEY}] failed chunk ${chunkIndex} at step '${step}': ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        runLog.rowsRead += rows.length;
        runLog.skippedNoKey += skipped;
        runLog.rowsLoadedToStaging += postResult.rowsLoadedToStaging;
        runLog.rowsInserted += postResult.rowsInserted;
        runLog.rowsUpdated += postResult.rowsUpdated;
        runLog.rowsRelationFilled += postResult.rowsRelationFilled;
        runLog.rowsSkippedExisting += postResult.rowsSkippedExisting;
        runLog.duplicateKeys += postResult.duplicateKeys;
        runLog.copyCdRows += postResult.copyCdRows;
        runLog.donationRows += postResult.donationRows;
        runLog.patientWanted += postResult.patientWanted;
        runLog.patientResolved += postResult.patientResolved;
        mergeFieldIssueChunk(fieldIssueAcc, {
          fieldIssues: postResult.fieldIssues,
        });

        chunkLog.record({
          chunkIndex,
          status: "success",
          rowCount: rows.length,
          rowsFetched: rows.length,
          firstKey: keys[0] ?? null,
          lastKey: keys.length > 0 ? keys[keys.length - 1] : null,
          rowsInserted: postResult.rowsInserted,
          rowsUpdated: postResult.rowsUpdated,
          rowsRelationFilled: postResult.rowsRelationFilled,
          rowsSkippedExisting: postResult.rowsSkippedExisting,
          skipped,
          fetchMs,
          chunkTotalMs: Date.now() - chunkStartedAt,
        });

        const advance = capAdvanceToMigratePlan(
          rows.length,
          rowsDoneThisRun,
          plannedRows,
          migration,
          idx.indexLimited,
        );
        if (advance <= 0) break;
        if (!repairRun.active) offset += advance;

        if (debugLogs && !singleLineUi) {
          writeOutLine(
            `>>> [${KEY}] chunk ${chunkIndex}/${plannedChunks ?? "?"} done ${formatSec(
              Date.now() - chunkStartedAt,
            )} +${advance} total=${offset}/${plannedRows ?? "?"} fetch=${formatSec(fetchMs)}`,
            uiState,
          );
        }
        if (progressEnabled) {
          renderProgress(
            rowsDoneInMigrateRun(offset, runStartOffset),
            progressTotal,
            startedAt,
            chunkIndex,
            plannedChunks,
            uiState,
          );
        }

        if (repairRun.active) {
          if (repairRunIsDone(repairRun)) break;
        } else if (
          shouldStopMigratePagination({
            advance,
            pageSize,
            rowsReadInWindow: rowsDoneInMigrateRun(offset, runStartOffset),
            plannedRows,
            migrationConfig: migration,
            indexLimited: idx.indexLimited,
          })
        ) {
          break;
        }
      }

      if (progressEnabled) endProgress(uiState);

      if (fieldIssueAcc.totalFieldIssueCount > 0) {
        const payload = buildFieldIssueLogPayload(fieldIssueAcc, {
          migrationKey: KEY,
          logType: "center_income_field_issues",
          recordIdKey: "center_income_key",
          buildRecord: (rec) => ({
            center_income_key: String(rec.center_income_key),
            pid: rec.pid ?? null,
            fieldIssues: rec.fieldIssues ?? [],
          }),
        });
        writeFieldIssueLogFile(fieldIssueLogPath, payload);
        runLog.fieldIssueLogPath = fieldIssueLogPath;
      }
      runLog.repairSummary = finishRepairRunSummary(
        KEY,
        REPAIR_SPEC_CENTER_INCOME,
        repairRun,
        { fieldIssueAcc },
      );

      const targetCount = await client.query(
        "SELECT COUNT(*)::bigint AS cnt FROM public.center_income WHERE old_db_id IS NOT NULL",
      );
      runLog.targetRowCount = Number(targetCount.rows[0]?.cnt ?? 0);
      console.error(
        `>>> [${KEY}] done, อ่านต้นทาง ${runLog.rowsRead} แถว (Copy CD ${runLog.copyCdRows}, บริจาค ${runLog.donationRows}) → insert ${runLog.rowsInserted}` +
          (migrateRowMode === "insert-only"
            ? `, มีอยู่แล้ว ${runLog.rowsSkippedExisting} (เติม patient_info ที่ว่าง ${runLog.rowsRelationFilled} แถว)`
            : `, update ${runLog.rowsUpdated}`) +
          (runLog.skippedNoKey > 0 ? `, ข้าม ${runLog.skippedNoKey} แถว (ไม่มี Income_ID)` : "") +
          (runLog.duplicateKeys > 0
            ? `, อ่านคีย์ซ้ำ ${runLog.duplicateKeys} แถว (เก็บแถวแรก)`
            : "") +
          ` — ปลายทางมีแถวจากระบบเดิม ${runLog.targetRowCount} แถว ${formatSec(Date.now() - startedAt)}`,
      );
      const patientMiss = runLog.patientWanted - runLog.patientResolved;
      console.error(
        `>>> [${KEY}] done: patient_info เจอ ${runLog.patientResolved}/${runLog.patientWanted} แถวที่มี PID` +
          (patientMiss > 0
            ? ` (ไม่เจอ ${patientMiss} — ไม่ผูก ดูรายตัวใน field issue log)`
            : ""),
      );
      runLog.status = "success";
    } finally {
      client.release();
    }
  } catch (err) {
    runLog.status = "failed";
    runLog.error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    await pool.close();
    await pgPool.end();
    runLog.finishedAt = new Date().toISOString();
    chunkLog.attachTo(runLog);
    fs.writeFileSync(logPath, `${JSON.stringify(runLog, null, 2)}\n`, "utf8");
    console.error(`>>> migration log saved: ${logPath}`);
    if (runLog.fieldIssueLogPath) {
      console.error(`>>> field issue log: ${runLog.fieldIssueLogPath}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
