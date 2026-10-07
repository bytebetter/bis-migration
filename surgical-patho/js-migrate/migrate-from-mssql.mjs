/**
 * surgical_patho — dbo.SURGICAL_PATHO (MSSQL) -> public.surgical_patho (Postgres/Directus)
 *
 * ตารางหลักหมื่นแถว ไม่มี CreatedDate — เดินครบทุกแถวทุกรอบ ไม่ใช้ checkpoint
 * เทียบด้วยคีย์ (old_pid, old_surgical_id): ไม่มีปลายทาง = insert, มีแล้ว = ไม่ทับข้อมูล
 * แต่เติม relation ที่ยังว่าง (insert-only) หรือเขียนทับให้ตรงต้นทาง (overwrite) — รันซ้ำได้ ไม่เกิดแถวซ้ำ
 * relation (patient_info / exam / procedure / last_exam) resolve จากเลขเดิม ดู surgicalPathoMapping.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import pg from "pg";
import {
  MSSQL_SURGICAL_PATHO_BY_KEYS_SELECT,
  MSSQL_SURGICAL_PATHO_SELECT,
} from "./mssqlSurgicalPathoSelect.mjs";
import { ensureSurgicalPathoPipelineDdl } from "./surgicalPathoPgDdl.mjs";
import {
  SURGICAL_PATHO_RELATIONS,
  normalizeSurgicalPathoMssqlRow,
  resetSurgicalPathoTargetColumnCache,
  runSurgicalPathoChunkPostLoad,
  surgicalPathoLookupWarnings,
  surgicalPathoRowKey,
} from "./surgicalPathoMapping.mjs";
import {
  createUiState,
  endProgress,
  formatSec,
  renderProgress,
  writeOutLine,
} from "../../shared/js-migrate/progressUi.mjs";
import { mergeMigrationWithCli } from "../../shared/js-migrate/mergeMigrationConfig.mjs";
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
import { REPAIR_SPEC_SURGICAL_PATHO } from "../../shared/js-migrate/migrateTableSpecs.mjs";
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
const KEY = "surgical_patho";

/** ตัวอย่างแถวที่ไม่มี PID / Surgical_ID ที่เก็บลง run log (ไม่ต้องเก็บทุกแถว) */
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
 * คีย์ของแถวที่ดึงได้ → คีย์ตามที่ขอมา (ต้นทางเทียบแบบไม่สนตัวพิมพ์: ขอ m84|1 ได้แถว M84|1)
 * ใช้กับ noteRepairBatchFetch ไม่ให้นับแถวที่เจอเป็น "ไม่พบในต้นทาง"
 * @param {string[]} requested
 */
function rowKeyMatchingRequested(requested) {
  const byLower = new Map(requested.map((k) => [String(k).toLowerCase(), String(k)]));
  return (row) => {
    const key = surgicalPathoRowKey(row) ?? "";
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
    rowsRelationFilled: 0,
    rowsSkippedExisting: 0,
    duplicateKeys: 0,
    skippedNoKey: 0,
    /** @type {object[]} */
    skippedNoKeySample: [],
    /** @type {Record<string, { has: number, ok: number }>} */
    relationStats: Object.fromEntries(
      SURGICAL_PATHO_RELATIONS.map((r) => [r.column, { has: 0, ok: 0 }]),
    ),
    /** @type {string[]} */
    warnings: [],
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

  const pageSql = MSSQL_SURGICAL_PATHO_SELECT.replaceAll(
    "{{sourceObject}}",
    sourceObjectNoLock,
  );
  const byKeysSqlTemplate = MSSQL_SURGICAL_PATHO_BY_KEYS_SELECT.replaceAll(
    "{{sourceObject}}",
    sourceObjectNoLock,
  );

  const pool = await sql.connect(buildMssqlConfig(config.source));
  try {
    const client = await pgPool.connect();
    try {
      resetSurgicalPathoTargetColumnCache();
      await ensureSurgicalPathoPipelineDdl(client);
      console.error(`>>> [${KEY}] source: ${sourceObject}`);
      console.error(
        `>>> [${KEY}] target: ${config.target.postgresDatabase} public.surgical_patho (เทียบด้วย old_pid + old_surgical_id, batchSize=${batchSize})`,
      );
      console.error(
        migrateRowMode === "insert-only"
          ? `>>> [${KEY}] migrateRowMode=insert-only: insert เฉพาะคีย์ใหม่ + เติม relation ที่ยังว่างของแถวเดิม (ไม่ทับข้อมูลที่แก้ในระบบใหม่)`
          : `>>> [${KEY}] migrateRowMode=overwrite: insert คีย์ใหม่ + เขียนทับแถวเดิมให้ตรงต้นทาง`,
      );
      console.error(
        `>>> [${KEY}] full pass: ไล่ทุกแถวตาม [PID], [Surgical_ID] ทุกรอบ (ไม่ใช้ checkpoint — รันซ้ำไม่เกิดแถวซ้ำ)`,
      );
      for (const w of await surgicalPathoLookupWarnings(client)) {
        runLog.warnings.push(w);
        console.error(`>>> [${KEY}] คำเตือน: ${w}`);
      }

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

      const fieldIssueAcc = createFieldIssueAccumulator("surgical_key");
      const fieldIssueLogPath = path.join(
        logsDir,
        `migration-field-issues-surgical_patho-${nowStamp()}.json`,
      );

      const repairRun = prepareRepairRun(
        migration,
        logsDir,
        REPAIR_SPEC_SURGICAL_PATHO,
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
            nvarcharLength: 400,
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
          const n = normalizeSurgicalPathoMssqlRow(r);
          if (n) {
            normalized.push(n);
            continue;
          }
          skipped += 1;
          if (runLog.skippedNoKeySample.length < SKIPPED_SAMPLE_MAX) {
            runLog.skippedNoKeySample.push({
              old_pid: r?.old_pid ?? null,
              old_surgical_id: r?.old_surgical_id ?? null,
              surgical_date: r?.surgical_date ?? null,
            });
          }
        }
        const keys = normalized.map(surgicalPathoRowKey);

        let step = "begin";
        /** @type {Awaited<ReturnType<typeof runSurgicalPathoChunkPostLoad>>} */
        let postResult;
        try {
          step = "BEGIN";
          await client.query("BEGIN");
          step = "load to staging + resolve relation + insert/update surgical_patho";
          postResult = await runSurgicalPathoChunkPostLoad(client, normalized, {
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
        for (const [col, s] of Object.entries(postResult.relationStats ?? {})) {
          runLog.relationStats[col].has += s.has;
          runLog.relationStats[col].ok += s.ok;
        }
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
          logType: "surgical_patho_field_issues",
          recordIdKey: "surgical_key",
          buildRecord: (rec) => ({
            surgical_key: String(rec.surgical_key),
            old_pid: rec.old_pid ?? null,
            old_surgical_id: rec.old_surgical_id ?? null,
            fieldIssues: rec.fieldIssues ?? [],
          }),
        });
        writeFieldIssueLogFile(fieldIssueLogPath, payload);
        runLog.fieldIssueLogPath = fieldIssueLogPath;
      }
      runLog.repairSummary = finishRepairRunSummary(
        KEY,
        REPAIR_SPEC_SURGICAL_PATHO,
        repairRun,
        { fieldIssueAcc },
      );

      const targetCount = await client.query(
        "SELECT COUNT(*)::bigint AS cnt FROM public.surgical_patho",
      );
      runLog.targetRowCount = Number(targetCount.rows[0]?.cnt ?? 0);
      console.error(
        `>>> [${KEY}] done, อ่านต้นทาง ${runLog.rowsRead} แถว → insert ${runLog.rowsInserted}` +
          (migrateRowMode === "insert-only"
            ? `, มีอยู่แล้ว ${runLog.rowsSkippedExisting} (เติม relation ที่ว่าง ${runLog.rowsRelationFilled} แถว)`
            : `, update ${runLog.rowsUpdated}`) +
          (runLog.skippedNoKey > 0
            ? `, ข้าม ${runLog.skippedNoKey} แถว (ไม่มี PID หรือ Surgical_ID)`
            : "") +
          (runLog.duplicateKeys > 0
            ? `, คีย์ซ้ำในต้นทาง ${runLog.duplicateKeys} แถว (เก็บแถวแรก)`
            : "") +
          ` — ปลายทางมี ${runLog.targetRowCount} แถว ${formatSec(Date.now() - startedAt)}`,
      );
      const relParts = SURGICAL_PATHO_RELATIONS.map((rel) => {
        const s = runLog.relationStats[rel.column];
        const miss = s.has - s.ok;
        return `${rel.column} เจอ ${s.ok}/${s.has}${miss > 0 ? ` (ไม่เจอ ${miss})` : ""}`;
      });
      console.error(
        `>>> [${KEY}] done: relation (เทียบแถวที่มีเลขเดิม) ${relParts.join(", ")}` +
          (SURGICAL_PATHO_RELATIONS.some(
            (rel) =>
              runLog.relationStats[rel.column].has >
              runLog.relationStats[rel.column].ok,
          )
            ? " — ที่ไม่เจอเป็น NULL ดูรายตัวใน field issue log"
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
