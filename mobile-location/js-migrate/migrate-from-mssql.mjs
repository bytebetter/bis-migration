/**
 * mobile_location — dbo.MOBILE_LOCATION (MSSQL) -> public.mobile_location (Postgres/Directus)
 *
 * ตาราง lookup เล็ก (หลักร้อยแถว) — เดินครบทุกแถวทุกรอบ ไม่ใช้ checkpoint
 * เทียบด้วย old_id (= [ID] ของ MSSQL): ไม่มีปลายทาง = insert, มีแล้ว = ปล่อยไว้ (insert-only)
 * หรืออัปเดตชื่อให้ตรงต้นทาง (overwrite) — รันซ้ำได้ ไม่เกิดแถวซ้ำ
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import pg from "pg";
import {
  MSSQL_MOBILE_LOCATION_DETAIL_BY_IDS_SELECT,
  MSSQL_MOBILE_LOCATION_ID_SELECT,
} from "./mssqlMobileLocationSelect.mjs";
import {
  ensureMobileLocationPipelineDdl,
  syncMobileLocationIdSequence,
} from "./mobileLocationPgDdl.mjs";
import {
  normalizeMobileLocationMssqlRow,
  resetMobileLocationTargetColumnCache,
  runMobileLocationChunkPostLoad,
} from "./mobileLocationMapping.mjs";
import {
  createUiState,
  endProgress,
  formatSec,
  renderProgress,
  writeOutLine,
} from "../../shared/js-migrate/progressUi.mjs";
import { mergeMigrationWithCli } from "../../shared/js-migrate/mergeMigrationConfig.mjs";
import { bindMigrateSrcNumericRange } from "../../shared/js-migrate/migrateCliArgs.mjs";
import {
  bracketMssqlIdent,
  buildMssqlConfig,
} from "../../shared/js-migrate/mssqlConnectConfig.mjs";
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
import { REPAIR_SPEC_MOBILE_LOCATION } from "../../shared/js-migrate/migrateTableSpecs.mjs";
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
const KEY = "mobile_location";

function getConfigPath() {
  const idx = process.argv.indexOf("--config");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return "../../migration.config.local.json";
}

function nowStamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function rowOldId(row) {
  const v = row?.old_id ?? row?.ID ?? row?.id ?? "";
  return String(v).trim();
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

  const { schema: sourceSchema, table: sourceTable } = resolveMssqlSourceObject(
    KEY,
    config.source,
  );
  const sourceObject = `${bracketMssqlIdent(sourceSchema)}.${bracketMssqlIdent(sourceTable)}`;
  const sourceObjectNoLock = `${sourceObject} WITH (NOLOCK)`;

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
    sourceObject: `${sourceSchema}.${sourceTable}`,
    migrateRowMode,
    batchSize,
    rowsRead: 0,
    rowsLoadedToStaging: 0,
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsUnchanged: 0,
    rowsSkippedExisting: 0,
    skipped: 0,
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

  const probeSql = MSSQL_MOBILE_LOCATION_ID_SELECT.replaceAll(
    "{{sourceObject}}",
    sourceObjectNoLock,
  );
  const detailSqlTemplate =
    MSSQL_MOBILE_LOCATION_DETAIL_BY_IDS_SELECT.replaceAll(
      "{{sourceObject}}",
      sourceObjectNoLock,
    );

  const pool = await sql.connect(buildMssqlConfig(config.source));
  try {
    const client = await pgPool.connect();
    try {
      resetMobileLocationTargetColumnCache();
      await ensureMobileLocationPipelineDdl(client);
      await syncMobileLocationIdSequence(client);
      console.error(`>>> [${KEY}] source: ${sourceObject}`);
      console.error(
        `>>> [${KEY}] target: ${config.target.postgresDatabase} public.mobile_location (เทียบด้วย old_id, batchSize=${batchSize})`,
      );
      console.error(
        migrateRowMode === "insert-only"
          ? `>>> [${KEY}] migrateRowMode=insert-only: insert เฉพาะ old_id ที่ยังไม่มี (ไม่ทับชื่อที่แก้ในระบบใหม่)`
          : `>>> [${KEY}] migrateRowMode=overwrite: insert แถวใหม่ + อัปเดตชื่อของ old_id เดิมให้ตรงต้นทาง`,
      );
      console.error(
        `>>> [${KEY}] full pass: ไล่ทุกแถวตาม [ID] ทุกรอบ (ไม่ใช้ checkpoint — รันซ้ำไม่เกิดแถวซ้ำ)`,
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
          .query(`SELECT COUNT_BIG(1) AS total FROM ${sourceObjectNoLock};`);
        sourceRowCountTotal = Number(countRes.recordset?.[0]?.total ?? 0);
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

      const fieldIssueAcc = createFieldIssueAccumulator("old_id");
      const fieldIssueLogPath = path.join(
        logsDir,
        `migration-field-issues-mobile_location-${nowStamp()}.json`,
      );

      const repairRun = prepareRepairRun(
        migration,
        logsDir,
        REPAIR_SPEC_MOBILE_LOCATION,
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

        /** @type {string[]} */
        let ids = [];
        /** @type {object[]} */
        let rows = [];
        let fetchMs = 0;

        if (repairRun.active) {
          const idBatch = takeNextRepairBatch(repairRun);
          if (!idBatch) break;
          ids = idBatch.map(String);
          const detailStartedAt = Date.now();
          rows = await fetchMssqlRowsByIds(pool, sql, {
            ids,
            detailSqlTemplate,
          });
          fetchMs = Date.now() - detailStartedAt;
          noteRepairBatchFetch(repairRun, ids, rows, rowOldId);
          if (rows.length === 0) {
            if (repairRunIsDone(repairRun)) break;
            continue;
          }
        } else {
          const probeStartedAt = Date.now();
          const probeReq = pool.request();
          bindMigrateSrcNumericRange(probeReq, migration, sql);
          const idRes = await probeReq
            .input("offset", sql.Int, offset)
            .input("page", sql.Int, pageSize)
            .query(probeSql);
          const probeMs = Date.now() - probeStartedAt;
          ids = (idRes.recordset || [])
            .map((r) => Number.parseInt(r?.old_id ?? "", 10))
            .filter((v) => Number.isFinite(v))
            .map(String);
          if (ids.length === 0) break;

          const detailStartedAt = Date.now();
          rows = await fetchMssqlRowsByIds(pool, sql, {
            ids,
            detailSqlTemplate,
          });
          fetchMs = probeMs + (Date.now() - detailStartedAt);
        }
        if (rows.length === 0) break;

        chunkIndex += 1;
        const normalized = rows
          .map(normalizeMobileLocationMssqlRow)
          .filter(Boolean);
        const skipped = rows.length - normalized.length;

        let step = "begin";
        /** @type {Awaited<ReturnType<typeof runMobileLocationChunkPostLoad>>} */
        let postResult;
        try {
          step = "BEGIN";
          await client.query("BEGIN");
          step = "load to staging + insert/update mobile_location";
          postResult = await runMobileLocationChunkPostLoad(client, normalized, {
            migrateRowMode,
          });
          step = "COMMIT";
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          chunkLog.recordFailure({
            chunkIndex,
            failedAtStep: step,
            rowCount: ids.length,
            rowsFetched: rows.length,
            firstKey: ids[0] ?? null,
            lastKey: ids.length > 0 ? ids[ids.length - 1] : null,
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
        runLog.skipped += skipped;
        runLog.rowsLoadedToStaging += postResult.rowsLoadedToStaging;
        runLog.rowsInserted += postResult.rowsInserted;
        runLog.rowsUpdated += postResult.rowsUpdated;
        runLog.rowsUnchanged += postResult.rowsUnchanged;
        runLog.rowsSkippedExisting += postResult.rowsSkippedExisting;
        mergeFieldIssueChunk(fieldIssueAcc, {
          fieldIssues: postResult.fieldIssues,
        });

        chunkLog.record({
          chunkIndex,
          status: "success",
          rowCount: ids.length,
          rowsFetched: rows.length,
          firstKey: ids[0] ?? null,
          lastKey: ids.length > 0 ? ids[ids.length - 1] : null,
          rowsInserted: postResult.rowsInserted,
          rowsUpdated: postResult.rowsUpdated,
          rowsUnchanged: postResult.rowsUnchanged,
          rowsSkippedExisting: postResult.rowsSkippedExisting,
          skipped,
          fetchMs,
          chunkTotalMs: Date.now() - chunkStartedAt,
        });

        const advance = capAdvanceToMigratePlan(
          ids.length,
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
          logType: "mobile_location_field_issues",
          recordIdKey: "old_id",
          buildRecord: (rec) => ({
            old_id: String(rec.old_id),
            fieldIssues: rec.fieldIssues ?? [],
          }),
        });
        writeFieldIssueLogFile(fieldIssueLogPath, payload);
        runLog.fieldIssueLogPath = fieldIssueLogPath;
      }
      runLog.repairSummary = finishRepairRunSummary(
        KEY,
        REPAIR_SPEC_MOBILE_LOCATION,
        repairRun,
        { fieldIssueAcc },
      );

      const targetCount = await client.query(
        "SELECT COUNT(*)::bigint AS cnt FROM public.mobile_location",
      );
      runLog.targetRowCount = Number(targetCount.rows[0]?.cnt ?? 0);
      console.error(
        `>>> [${KEY}] อ่านต้นทาง ${runLog.rowsRead} แถว → insert ${runLog.rowsInserted}` +
          (migrateRowMode === "insert-only"
            ? `, มีอยู่แล้วไม่แตะ ${runLog.rowsSkippedExisting}`
            : `, update ${runLog.rowsUpdated}, ชื่อตรงอยู่แล้ว ${runLog.rowsUnchanged}`) +
          (runLog.skipped > 0
            ? `, ข้าม ${runLog.skipped} แถว (ID ไม่ใช่ตัวเลข)`
            : "") +
          ` — ปลายทางมี ${runLog.targetRowCount} แถว ${formatSec(Date.now() - startedAt)}`,
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
