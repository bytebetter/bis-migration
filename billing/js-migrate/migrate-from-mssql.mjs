import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import pg from "pg";
import {
  MSSQL_BILLING_DETAIL_BY_IDS_SELECT,
  MSSQL_BILLING_ID_SELECT,
  MSSQL_BILLING_KEYSET_SELECT,
} from "./mssqlBillingSelect.mjs";
import { ensureBillingPipelineDdl } from "./billingPgDdl.mjs";
import {
  BILLING_STAGING_COLUMNS,
  mssqlRowValidForStaging,
  countBillingTargetRows,
  filterBillingFetchRowsInsertOnly,
  prepareBillingPostLoad,
  resetBillingIdSequenceIfEmpty,
  resetBillingTargetColumnCache,
  runBillingChunkPostLoad,
  stagingCellFromMssql,
  syncBillingIdSequenceOnce,
} from "./billingMapping.mjs";
import {
  createUiState,
  endProgress,
  formatSec,
  renderProgress,
  writeOutLine,
} from "../../shared/js-migrate/progressUi.mjs";
import { mergeMigrationWithCli } from "../../shared/js-migrate/mergeMigrationConfig.mjs";
import {
  bindMigrateSrcNumericRange,
  readNumericSourceKeyBounds,
} from "../../shared/js-migrate/migrateCliArgs.mjs";
import { examinationExamNumericRangePredicate } from "../../shared/js-migrate/migrateMssqlBindings.mjs";
import {
  applySourceIndexToMigrateJob,
  buildIndexCheckpointSuffix,
  isIndexWindowComplete,
  narrowPlannedRowsForIndex,
  resolvePageSize,
} from "../../shared/js-migrate/sourceIndexRange.mjs";
import { fetchMssqlRowsByIds } from "../../shared/js-migrate/fetchMssqlByIds.mjs";
import { REPAIR_SPEC_BILLING } from "../../shared/js-migrate/migrateTableSpecs.mjs";
import {
  finishRepairRunSummary,
  explicitIdsProgressPlan,
  prepareRepairRun,
  repairRunIsDone,
  repairRunIsEmpty,
  takeNextRepairBatch,
  noteRepairBatchFetch,
} from "../../shared/js-migrate/repairRun.mjs";
import {
  isLastKeysetPage,
  resolveKeysetAdvance,
} from "../../shared/js-migrate/twoStepKeyset.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = "billing";
const BILLING_EXAM_NUMERIC_KEY_RANGE_PRED =
  examinationExamNumericRangePredicate();

function getConfigPath() {
  const idx = process.argv.indexOf("--config");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return "../../migration.config.local.json";
}

function getProfileName() {
  const idx = process.argv.indexOf("--profile");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env.MIGRATION_PROFILE || null;
}

function nowStamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function parseMssqlUrl(rawUrl) {
  const normalized = rawUrl.replace(/^microsoftsqlserver:\/\//i, "mssql://");
  const u = new URL(normalized);
  return {
    server: u.hostname,
    port: u.port ? Number(u.port) : 1433,
    database: u.pathname.replace(/^\/+/, ""),
    user: decodeURIComponent(u.username || ""),
    password: decodeURIComponent(u.password || ""),
    options: {
      encrypt: true,
      trustServerCertificate: true,
    },
    pool: { max: 5, min: 0 },
  };
}

function tediousOptionsFromSource(sourceConfig = {}) {
  return {
    encrypt: sourceConfig.encrypt !== false,
    trustServerCertificate: sourceConfig.trustServerCertificate !== false,
    requestTimeout:
      sourceConfig.requestTimeout == null
        ? 0
        : Number(sourceConfig.requestTimeout),
    connectTimeout:
      sourceConfig.connectTimeout == null
        ? 60000
        : Number(sourceConfig.connectTimeout),
    cancelTimeout:
      sourceConfig.cancelTimeout == null
        ? 0
        : Number(sourceConfig.cancelTimeout),
  };
}

function buildMssqlConfig(sourceConfig = {}) {
  const timeouts = tediousOptionsFromSource(sourceConfig);
  if (sourceConfig.mssqlUrl) {
    const base = parseMssqlUrl(sourceConfig.mssqlUrl);
    return {
      ...base,
      options: {
        ...base.options,
        ...timeouts,
      },
    };
  }
  return {
    server: sourceConfig.server,
    port: Number(sourceConfig.port ?? 1433),
    database: sourceConfig.database,
    user: sourceConfig.user,
    password: sourceConfig.password,
    options: timeouts,
    pool: { max: 5, min: 0 },
  };
}

function resolveRuntimeConfig(rawConfig, fallbackProfile) {
  if (!rawConfig?.profiles) return rawConfig;
  const selectedProfile =
    getProfileName() ?? rawConfig.defaultProfile ?? fallbackProfile;
  const profileConfig = rawConfig.profiles[selectedProfile];
  if (!profileConfig) {
    throw new Error(
      `Profile '${selectedProfile}' not found in config.profiles`,
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
    __profileName: selectedProfile,
  };
}

function bracketIdent(value) {
  return `[${String(value).replace(/]/g, "]]")}]`;
}

function readJsonIfExists(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) return fallbackValue;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** โหลด staging แบบ patient_info — toStr ตรงจาก MSSQL ไม่ normalize ซ้ำทุกคอลัมน์ */
async function loadChunkToStaging(pgClient, mssqlRows) {
  const cols = BILLING_STAGING_COLUMNS;
  const arrays = cols.map(() => []);
  let n = 0;
  for (const raw of mssqlRows) {
    if (!mssqlRowValidForStaging(raw)) continue;
    for (let i = 0; i < cols.length; i++) {
      arrays[i].push(stagingCellFromMssql(raw, cols[i]));
    }
    n += 1;
  }
  if (n === 0) return { loaded: 0, stagingMs: 0 };
  const stagingStartedAt = Date.now();
  await pgClient.query("TRUNCATE TABLE migrate_stg.billing_mssql;");
  const castArgs = cols.map((_, i) => `$${i + 1}::text[]`).join(", ");
  await pgClient.query(
    `
INSERT INTO migrate_stg.billing_mssql (${cols.join(", ")})
SELECT * FROM unnest(${castArgs});
`.trim(),
    arrays,
  );
  return { loaded: n, stagingMs: Date.now() - stagingStartedAt };
}

async function main() {
  const configPath = path.resolve(process.cwd(), getConfigPath());
  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const config = resolveRuntimeConfig(rawConfig, "billing");
  const migration = mergeMigrationWithCli(config?.migration, "billing");
  if (config.__profileName) {
    console.error(`>>> using config profile: ${config.__profileName}`);
  }

  const sourceSchema = config.source?.schema ?? "dbo";
  const sourceTable = config.source?.table ?? "billing";
  const sourceObject = `${bracketIdent(sourceSchema)}.${bracketIdent(sourceTable)}`;
  const sourceObjectNoLock = `${sourceObject} WITH (NOLOCK)`;
  /** ค่าเริ่มต้น: probe+IN แบบ examination (เร็วกว่าคิวรีเดียวที่มี ~70 คอลัมน์บน MSSQL ไกล) */
  const mssqlOptimizeSingleQuery = migration.mssqlOptimizeSingleQuery === true;

  const probeSql = MSSQL_BILLING_ID_SELECT.replaceAll(
    "{{sourceObject}}",
    sourceObjectNoLock,
  );
  const detailSqlTemplate = MSSQL_BILLING_DETAIL_BY_IDS_SELECT.replaceAll(
    "{{sourceObject}}",
    sourceObjectNoLock,
  );
  const keysetSql = MSSQL_BILLING_KEYSET_SELECT.replaceAll(
    "{{sourceObject}}",
    sourceObjectNoLock,
  );

  const batchSize = Math.max(
    100,
    Math.min(5000, Number(migration.batchSize ?? 2000)),
  );
  const progressEnabled = migration.progressUi !== false;
  const singleLineUi = migration.singleLineUi !== false;
  const probeTiming = migration.probeTiming === true;
  const debugLogs = migration.debugLogs === true || probeTiming;
  const uiState = createUiState();
  const kb = readNumericSourceKeyBounds(migration);
  const sourceLimitRaw = migration.sourceLimit;
  const sourceLimit =
    sourceLimitRaw == null ? null : Math.max(1, Number(sourceLimitRaw));

  const pgPool = new pg.Pool({
    host: config.target.postgresHost,
    port: Number(config.target.postgresPort ?? 5432),
    user: config.target.postgresUser,
    password: config.target.postgresPassword,
    database: config.target.postgresDatabase ?? "bisinfo_dev_clone",
    max: 3,
  });

  const logsDir = path.resolve(__dirname, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, `migrate-${nowStamp()}.json`);
  const runLog = {
    startedAt: new Date().toISOString(),
    status: "running",
    sourceObject: `${sourceSchema}.${sourceTable}`,
    batchSize,
    mssqlOptimizeSingleQuery,
    rowsLoadedToStaging: 0,
    rowsUpserted: 0,
    skipped: 0,
    error: null,
  };
  const checkpointEnabled = migration.enableCheckpoint !== false;
  const checkpointDir = path.resolve(
    __dirname,
    migration.checkpointDir ?? "./checkpoints",
  );
  fs.mkdirSync(checkpointDir, { recursive: true });
  const indexCkSuffix = buildIndexCheckpointSuffix(migration);
  const checkpointPath = path.join(
    checkpointDir,
    `${KEY}${indexCkSuffix}.json`,
  );
  const checkpoint = readJsonIfExists(checkpointPath, {
    key: KEY,
    offset: 0,
    afterExamId: 0,
    completed: false,
    updatedAt: null,
  });

  const mssqlConfig = buildMssqlConfig(config.source);
  const pool = await sql.connect(mssqlConfig);
  try {
    const client = await pgPool.connect();
    try {
      resetBillingTargetColumnCache();
      await ensureBillingPipelineDdl(client);
      console.error(`>>> [${KEY}] source: ${sourceObject}`);
      console.error(
        `>>> [${KEY}] target: ${config.target.postgresDatabase} public.billing (batchSize=${batchSize})`,
      );
      const migrateRowMode = migration.migrateRowMode ?? "insert-only";
      if (migrateRowMode === "insert-only") {
        console.error(
          `>>> [${KEY}] migrateRowMode=insert-only (เพิ่มเท่าที่ยังไม่มี old_exam_id ใน Postgres — ไม่ DELETE ของเดิม)`,
        );
      }

      await prepareBillingPostLoad(client, migrateRowMode);

      const repairRun = prepareRepairRun(
        migration,
        logsDir,
        REPAIR_SPEC_BILLING,
        batchSize,
      );

      let offset = Number(checkpointEnabled ? checkpoint.offset : 0);
      if (!Number.isFinite(offset) || offset < 0) offset = 0;
      let afterExamId = Number(checkpointEnabled ? checkpoint.afterExamId : 0);
      if (!Number.isFinite(afterExamId) || afterExamId < 0) afterExamId = 0;

      const targetRowCount = await countBillingTargetRows(client);
      if (targetRowCount === 0 && !repairRun.active) {
        const hadCheckpointProgress =
          offset > 0 || afterExamId > 0 || checkpoint.completed === true;
        offset = 0;
        afterExamId = 0;
        await resetBillingIdSequenceIfEmpty(client);
        if (checkpointEnabled) {
          writeJson(checkpointPath, {
            key: KEY,
            offset: 0,
            afterExamId: 0,
            completed: false,
            updatedAt: new Date().toISOString(),
          });
        }
      }

      const idx = applySourceIndexToMigrateJob({
        key: KEY,
        migrationConfig: migration,
        checkpointEnabled,
        offset,
        useMssqlKeyset: true,
      });
      offset = idx.offset;
      if (kb.min != null) {
        const floorExclusive = Number(kb.min) - 1;
        if (afterExamId < floorExclusive) afterExamId = floorExclusive;
      }

      if (kb.min != null || kb.max != null) {
        console.error(
          `>>> [${KEY}] source key numeric range: min=${kb.min ?? "unset"} max=${kb.max ?? "unset"}`,
        );
      }
      console.error(
        `>>> [${KEY}] start offset: ${offset} (MSSQL keyset ตาม [Exam_ID], afterExamId=${afterExamId})`,
      );
      if (!mssqlOptimizeSingleQuery) {
        console.error(
          `>>> [${KEY}] MSSQL two-step fetch: probe Exam_ID แล้ว detail IN (แบบ examination)`,
        );
      }

      let chunkIndex = 0;
      let plannedRows = sourceLimit;
      if (plannedRows == null && progressEnabled) {
        try {
          const countReq = pool.request();
          bindMigrateSrcNumericRange(countReq, migration, sql);
          const countRes = await countReq.query(
            `SELECT COUNT_BIG(1) AS total FROM ${sourceObjectNoLock} WHERE (${BILLING_EXAM_NUMERIC_KEY_RANGE_PRED});`,
          );
          plannedRows = Number(countRes.recordset?.[0]?.total ?? 0);
        } catch {
          plannedRows = null;
        }
      }
      if (idx.indexLimited) {
        plannedRows = narrowPlannedRowsForIndex({
          plannedRows,
          offset,
          sourceIndexFrom: idx.sourceIndexFrom,
          sourceIndexTo: idx.sourceIndexTo,
        });
      }
      let progressTotal = plannedRows ?? null;
      let plannedChunks =
        plannedRows != null && plannedRows > 0
          ? Math.ceil(plannedRows / batchSize)
          : null;
      if (sourceLimit != null) {
        console.error(
          `>>> [${KEY}] TEMP sourceLimit enabled: ${sourceLimit} records`,
        );
      }
      if (plannedChunks != null) {
        console.error(
          `>>> [${KEY}] plan: ${plannedRows} rows, ~${plannedChunks} chunks`,
        );
      }
      if (probeTiming) {
        console.error(
          `>>> [${KEY}] probeTiming enabled (MSSQL query latency logs)`,
        );
      }
      const idPlan = explicitIdsProgressPlan(repairRun, batchSize);
      if (idPlan) {
        plannedRows = idPlan.plannedRows;
        plannedChunks = idPlan.plannedChunks;
        progressTotal = idPlan.plannedRows;
      }
      if (repairRunIsEmpty(repairRun)) {
        runLog.status = "success";
        return;
      }
      let total = 0;
      const startedAt = Date.now();
      while (true) {
        const pageSize = resolvePageSize({
          batchSize,
          total,
          sourceLimit,
          plannedRows: idx.indexLimited ? plannedRows : null,
        });
        if (pageSize <= 0) break;
        const nextChunkIndex = chunkIndex + 1;
        if (debugLogs && !singleLineUi) {
          writeOutLine(
            `>>> [${KEY}] fetch chunk ${nextChunkIndex}: afterExamId=${afterExamId} pageSize=${pageSize}`,
            uiState,
          );
        }

        const chunkStartedAt = Date.now();
        /** @type {string[]} */
        let ids = [];
        let rows = [];
        let fetchMs = 0;
        let idFetchMs = 0;
        let detailMs = 0;

        if (repairRun.active) {
          const idBatch = takeNextRepairBatch(repairRun);
          if (!idBatch) break;
          ids = idBatch.map(String);
          const detailStartedAt = Date.now();
          rows = await fetchMssqlRowsByIds(pool, sql, {
            ids,
            detailSqlTemplate,
          });
          detailMs = Date.now() - detailStartedAt;
          fetchMs = detailMs;
          noteRepairBatchFetch(repairRun, ids, rows, (r) =>
            String(r?.exam_id ?? "").trim(),
          );
          if (rows.length === 0) continue;
        } else if (mssqlOptimizeSingleQuery) {
          const fetchReq = pool.request();
          bindMigrateSrcNumericRange(fetchReq, migration, sql);
          const fetchStartedAt = Date.now();
          const fetchRes = await fetchReq
            .input("afterExamId", sql.BigInt, afterExamId)
            .input("page", sql.Int, pageSize)
            .query(keysetSql);
          fetchMs = Date.now() - fetchStartedAt;
          rows = fetchRes.recordset || [];
          ids = rows
            .map((r) => Number.parseInt(String(r?.exam_id ?? "").trim(), 10))
            .filter((v) => Number.isFinite(v))
            .map(String);
          if (debugLogs && !singleLineUi) {
            writeOutLine(
              `>>> [${KEY}] fetch chunk ${chunkIndex + 1} keyset-single: rows=${rows.length}, ms=${fetchMs}`,
              uiState,
            );
          }
          if (ids.length === 0) break;
        } else {
          const idReq = pool.request();
          bindMigrateSrcNumericRange(idReq, migration, sql);
          const idFetchStartedAt = Date.now();
          const idRes = await idReq
            .input("afterExamId", sql.BigInt, afterExamId)
            .input("page", sql.Int, pageSize)
            .query(probeSql);
          idFetchMs = Date.now() - idFetchStartedAt;
          ids = (idRes.recordset || [])
            .map((r) => Number.parseInt(String(r?.exam_id ?? "").trim(), 10))
            .filter((v) => Number.isFinite(v))
            .map(String);
          if (ids.length === 0) break;

          const detailStartedAt = Date.now();
          rows = await fetchMssqlRowsByIds(pool, sql, {
            ids,
            detailSqlTemplate,
          });
          detailMs = Date.now() - detailStartedAt;
          fetchMs = idFetchMs + detailMs;
          if (debugLogs && !singleLineUi) {
            writeOutLine(
              `>>> [${KEY}] fetch chunk ${chunkIndex + 1} probe+IN: rows=${rows.length}, ms=${fetchMs} (id=${idFetchMs}, detail=${detailMs})`,
              uiState,
            );
          }
        }

        if (rows.length === 0) break;

        const keysetAdvance = resolveKeysetAdvance(
          mssqlOptimizeSingleQuery ? null : ids.length,
          rows.length,
        );
        let stagingRows = rows;
        if (migrateRowMode === "insert-only" && !repairRun.active) {
          stagingRows = await filterBillingFetchRowsInsertOnly(client, rows);
        }
        const n = stagingRows.length;
        chunkIndex += 1;

        if (n === 0) {
          total += keysetAdvance;
          if (!repairRun.active) {
            offset += keysetAdvance;
            if (ids.length > 0) {
              afterExamId =
                Number.parseInt(ids[ids.length - 1], 10) || afterExamId;
            }
            if (checkpointEnabled) {
              writeJson(checkpointPath, {
                key: KEY,
                offset,
                afterExamId,
                completed: false,
                updatedAt: new Date().toISOString(),
              });
            }
          }
          if (debugLogs && !singleLineUi) {
            writeOutLine(
              `>>> [${KEY}] chunk ${chunkIndex}/${plannedChunks ?? "?"} skip (insert-only ครบใน Postgres แล้ว) keyset ${keysetAdvance}, total ${total}/${plannedRows ?? "?"}`,
              uiState,
            );
          }
          if (progressEnabled) {
            renderProgress(
              total,
              progressTotal,
              startedAt,
              chunkIndex,
              plannedChunks,
              uiState,
            );
          }
          const emptyLast = repairRun.active
            ? repairRunIsDone(repairRun)
            : isLastKeysetPage(keysetAdvance, pageSize);
          if (emptyLast) break;
          continue;
        }

        let step = "begin";
        let loaded = 0;
        let stagingResult = { loaded: 0, stagingMs: 0 };
        let pgTimings = {
          postgresMs: 0,
          mapMs: 0,
          deleteMs: 0,
          insertMs: 0,
          updateAppointmentMs: 0,
        };
        try {
          step = "BEGIN";
          await client.query("BEGIN");
          step = "load to staging";
          stagingResult = await loadChunkToStaging(client, stagingRows);
          loaded = stagingResult.loaded;
          runLog.rowsLoadedToStaging += loaded;
          runLog.skipped += Math.max(0, rows.length - loaded);
          step = "post-load mapping";
          pgTimings = await runBillingChunkPostLoad(client, migrateRowMode);
          runLog.rowsUpserted += loaded;
          step = "COMMIT";
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw new Error(
            `[${KEY}] failed chunk ${chunkIndex} at step '${step}': ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        total += keysetAdvance;
        if (!repairRun.active) {
          offset += keysetAdvance;
          if (ids.length > 0) {
            afterExamId =
              Number.parseInt(ids[ids.length - 1], 10) || afterExamId;
          }
          if (checkpointEnabled) {
            writeJson(checkpointPath, {
              key: KEY,
              offset,
              afterExamId,
              completed: false,
              updatedAt: new Date().toISOString(),
            });
          }
        }

        const postLoadMs = stagingResult.stagingMs + pgTimings.postgresMs;
        if (probeTiming && !singleLineUi && (idFetchMs > 0 || detailMs > 0)) {
          writeOutLine(
            `>>> [${KEY}] chunk ${chunkIndex} id_fetch_ms=${idFetchMs} detail_fetch_ms=${detailMs}`,
            uiState,
          );
        }
        if (debugLogs && !singleLineUi) {
          const detailNote =
            keysetAdvance !== rows.length ? ` detail ${rows.length}` : "";
          writeOutLine(
            `>>> [${KEY}] chunk ${chunkIndex}/${plannedChunks ?? "?"} done ${formatSec(
              Date.now() - chunkStartedAt,
            )} (fetch ${formatSec(fetchMs)}, post ${formatSec(postLoadMs)}) keyset ${keysetAdvance}${detailNote} staging ${loaded}, total ${total}/${plannedRows ?? "?"}`,
            uiState,
          );
        }
        if (progressEnabled) {
          renderProgress(
            total,
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
          isIndexWindowComplete({
            indexLimited: idx.indexLimited,
            plannedRows,
            rowsReadInWindow: total,
          }) ||
          isLastKeysetPage(keysetAdvance, pageSize)
        ) {
          break;
        }
      }

      if (checkpointEnabled) {
        writeJson(checkpointPath, {
          key: KEY,
          offset,
          afterExamId,
          completed: true,
          updatedAt: new Date().toISOString(),
        });
      }
      if (progressEnabled) endProgress(uiState);

      await syncBillingIdSequenceOnce(client);
      runLog.repairSummary = finishRepairRunSummary(
        KEY,
        REPAIR_SPEC_BILLING,
        repairRun,
        {},
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
    fs.writeFileSync(logPath, `${JSON.stringify(runLog, null, 2)}\n`, "utf8");
    console.error(`>>> migration log saved: ${logPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
