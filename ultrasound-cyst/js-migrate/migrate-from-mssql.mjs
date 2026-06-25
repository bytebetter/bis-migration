import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import pg from "pg";
import { createMssqlUltrasoundCystSelectBundle } from "./mssqlUltrasoundCystSelect.mjs";
import { bindMssqlSourceObjectPlaceholders } from "../../shared/js-migrate/mssqlExamTwoStepSelect.mjs";
import {
  setupCreatedDateMigrationSort,
  initCreatedDateKeysetState,
} from "../../shared/js-migrate/setupCreatedDateMigrationSort.mjs";
import {
  buildCreatedDateCheckpointFields,
  initExamChildCompositeKeysetFromCheckpoint,
  advanceExamChildCompositeKeyset,
  queryExamChildKeysetPage,
  reconcileLegacyExamChildCheckpoint,
} from "../../shared/js-migrate/createdDateKeysetFetch.mjs";
import { ensureUltrasoundCystPipelineDdl } from "./ultrasoundCystPgDdl.mjs";
import {
  ULTRASOUND_CYST_STAGING_COLUMNS,
  normalizeMssqlRow,
  runUltrasoundCystChunkPostLoad,
} from "./ultrasoundCystMapping.mjs";
import {
  buildFieldIssueLogPayload,
  createFieldIssueAccumulator,
  mergeFieldIssueChunk,
  writeFieldIssueLogFile,
} from "../../shared/js-migrate/fieldIssueLog.mjs";
import {
  buildCompositeStagingFieldIssueConfig,
  runCompositeStagingFieldIssuePipeline,
} from "../../shared/js-migrate/stagingFieldIssues.mjs";
import {
  createUiState,
  endProgress,
  formatSec,
  markProgressInline,
  renderProgress,
  writeOutLine,
} from "../../shared/js-migrate/progressUi.mjs";
import { mergeMigrationWithCli } from "../../shared/js-migrate/mergeMigrationConfig.mjs";
import {
  applySourceIndexToMigrateJob,
  buildIndexCheckpointSuffix,
  resolvePageSize,
  plannedRowsForPageSize,
  trimRowsToMigrateCap,
  capAdvanceToMigratePlan,
  rowsDoneInMigrateRun,
  shouldMarkMigrateCheckpointComplete,
  shouldStopMigratePagination,
  assertMigrationReachedPlan,
} from "../../shared/js-migrate/sourceIndexRange.mjs";
import {
  prepareMigrateRowPlan,
  readSourceCountCap,
} from "../../shared/js-migrate/sourceCountSnapshot.mjs";
import { fetchMssqlRowsByIds } from "../../shared/js-migrate/fetchMssqlByIds.mjs";
import { REPAIR_SPEC_ULTRASOUND_CYST } from "../../shared/js-migrate/migrateTableSpecs.mjs";
import {
  explicitIdsProgressPlan,
  prepareRepairRun,
  repairRunIsDone,
  repairRunIsEmpty,
  finishRepairRunSummary,
  noteRepairBatchFetch,
  takeNextRepairBatch,
} from "../../shared/js-migrate/repairRun.mjs";
import {
  createChunkResultsLogger,
  firstLastCompositeKey,
} from "../../shared/js-migrate/chunkResultsLog.mjs";

const COMPOSITE_FIELD_ISSUE = buildCompositeStagingFieldIssueConfig(
  "described_cyst_id",
  "ultrasound_cyst",
  "migrate_stg.ultrasound_cyst_mssql",
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = "ultrasound_cyst";

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

async function loadChunkToStaging(pgClient, normalizedRows) {
  const cols = ULTRASOUND_CYST_STAGING_COLUMNS;
  const arrays = cols.map(() => []);
  for (const r of normalizedRows) {
    if (!r) continue;
    for (let i = 0; i < cols.length; i++) {
      arrays[i].push(r[cols[i]] ?? "");
    }
  }
  if (arrays[0].length === 0) return 0;
  await pgClient.query("TRUNCATE TABLE migrate_stg.ultrasound_cyst_mssql;");
  const castArgs = cols.map((_, i) => `$${i + 1}::text[]`).join(", ");
  await pgClient.query(
    `
INSERT INTO migrate_stg.ultrasound_cyst_mssql (${cols.join(", ")})
SELECT * FROM unnest(${castArgs});
`.trim(),
    arrays,
  );
  return arrays[0].length;
}

async function main() {
  const configPath = path.resolve(process.cwd(), getConfigPath());
  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const config = resolveRuntimeConfig(rawConfig, "ultrasound_cyst");
  const migration = mergeMigrationWithCli(config?.migration, "ultrasound_cyst");
  if (config.__profileName) {
    console.error(`>>> using config profile: ${config.__profileName}`);
  }

  const sourceSchema = config.source?.schema ?? "dbo";
  const sourceTable = config.source?.table ?? "ultrasound_cyst";
  const sourceObject = `${bracketIdent(sourceSchema)}.${bracketIdent(sourceTable)}`;
  const sourceObjectNoLock = `${sourceObject} WITH (NOLOCK)`;

  const batchSize = Math.max(
    100,
    Math.min(20000, Number(migration.batchSize ?? 2000)),
  );
  const progressEnabled = migration.progressUi !== false;
  const singleLineUi = migration.singleLineUi !== false;
  const debugLogs = migration.debugLogs === true;
  const uiState = createUiState();

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
    rowsLoadedToStaging: 0,
    rowsUpserted: 0,
    skipped: 0,
    error: null,
  };
  const chunkLog = createChunkResultsLogger(migration);
  const checkpointEnabled = migration.enableCheckpoint !== false;
  const checkpointDir = path.resolve(
    __dirname,
    migration.checkpointDir ?? "./checkpoints",
  );
  fs.mkdirSync(checkpointDir, { recursive: true });
  const indexCkSuffix = buildIndexCheckpointSuffix(migration);
  const checkpointPath = path.join(checkpointDir, `${KEY}${indexCkSuffix}.json`);
  const checkpoint = readJsonIfExists(checkpointPath, {
    key: KEY,
    offset: 0,
    afterExamId: 0,
    afterChildId: 0,
    completed: false,
    updatedAt: null,
  });

  const mssqlConfig = buildMssqlConfig(config.source);
  const mssqlConnectStartedAt = Date.now();
  const pool = await sql.connect(mssqlConfig);
  if (debugLogs) {
    writeOutLine(
      `>>> [${KEY}] MSSQL connected in ${formatSec(Date.now() - mssqlConnectStartedAt)}`,
      uiState,
    );
  }

  const sortBundle = await setupCreatedDateMigrationSort(pool, {
    migrationConfig: migration,
    sourceSchema,
    sourceTable,
    tableLabel: KEY,
    createSelectBundle: createMssqlUltrasoundCystSelectBundle,
  });
  const keysetSql = bindMssqlSourceObjectPlaceholders(
    sortBundle.keysetSql,
    sourceObject,
  );
  const detailSqlTemplate = bindMssqlSourceObjectPlaceholders(
    sortBundle.detailByExamIdsSql,
    sourceObject,
  );

  try {
    const probeTableSql = `SELECT TOP 1 [Exam_ID], [Described_Cyst_ID] FROM ${sourceObjectNoLock} ORDER BY [Exam_ID] ASC, [Described_Cyst_ID] ASC;`;
    const probeStartedAt = Date.now();
    await pool.request().query(probeTableSql);
    if (debugLogs) {
      writeOutLine(
        `>>> [${KEY}] MSSQL probe done in ${formatSec(Date.now() - probeStartedAt)}`,
        uiState,
      );
    }

    const pgConnectStartedAt = Date.now();
    const client = await pgPool.connect();
    if (debugLogs) {
      writeOutLine(
        `>>> [${KEY}] Postgres connected in ${formatSec(Date.now() - pgConnectStartedAt)}`,
        uiState,
      );
    }
    try {
      const ensureDdlStartedAt = Date.now();
      await ensureUltrasoundCystPipelineDdl(client);
      if (debugLogs) {
        writeOutLine(
          `>>> [${KEY}] ensure pipeline DDL in ${formatSec(Date.now() - ensureDdlStartedAt)}`,
          uiState,
        );
      }
      console.error(`>>> [${KEY}] source: ${sourceObject}`);
      console.error(
        `>>> [${KEY}] target: ${config.target.postgresDatabase} public.ultrasound_cyst (batchSize=${batchSize})`,
      );

      const keysetState = initCreatedDateKeysetState(
        checkpoint,
        checkpointEnabled,
        sortBundle,
      );
      let offset = keysetState.offset;
      let afterExamId = keysetState.numericAfter;
      let mssqlKeysetAfter = keysetState.mssqlKeysetAfter;
      let afterChildId = Number(checkpointEnabled ? checkpoint.afterChildId : 0);
      if (!Number.isFinite(afterChildId) || afterChildId < 0) afterChildId = 0;
      let compositeKs = initExamChildCompositeKeysetFromCheckpoint(
        checkpoint,
        checkpointEnabled,
        keysetState.sortKeyVersionUpgraded,
      );
      if (keysetState.sortKeyVersionUpgraded && checkpointEnabled) {
        afterChildId = 0;
        compositeKs = initExamChildCompositeKeysetFromCheckpoint({}, false, true);
        writeJson(
          checkpointPath,
          buildCreatedDateCheckpointFields(sortBundle, {
            offset: 0,
            mssqlKeysetAfter: "",
            afterExamId: 0,
            completed: false,
            composite: compositeKs,
            extra: { key: KEY, afterChildId: 0 },
          }),
        );
      }
      const legacyCk = reconcileLegacyExamChildCheckpoint({
        sortBundle,
        checkpoint,
        checkpointEnabled,
      });
      if (legacyCk.reset && checkpointEnabled) {
        console.error(
          `>>> [${KEY}] legacy keyset (Exam_ID+child) — รีเซ็ต checkpoint จาก CreatedDate sort`,
        );
        offset = legacyCk.offset;
        afterExamId = legacyCk.afterExamId;
        afterChildId = legacyCk.afterChildId;
        compositeKs = initExamChildCompositeKeysetFromCheckpoint({}, false, true);
        writeJson(checkpointPath, {
          key: KEY,
          offset: 0,
          afterExamId: 0,
          afterChildId: 0,
          completed: false,
          sortKeyVersion: 1,
          updatedAt: new Date().toISOString(),
        });
      }
      const idx = applySourceIndexToMigrateJob({
        key: KEY,
        migrationConfig: migration,
        checkpointEnabled,
        offset,
        useMssqlKeyset: true,
      });
      offset = idx.offset;
      const fieldIssueAcc = createFieldIssueAccumulator("record_key");
      const fieldIssueLogPath = path.join(
        logsDir,
        `migration-field-issues-ultrasound_cyst-${nowStamp()}.json`,
      );
      let chunkIndex = 0;
      let sourceRowCountTotal = null;
      if (progressEnabled) {
        try {
          const countRes = await pool
            .request()
            .query(`SELECT COUNT_BIG(1) AS total FROM ${sourceObjectNoLock};`);
          sourceRowCountTotal = Number(countRes.recordset?.[0]?.total ?? 0);
        } catch {
          sourceRowCountTotal = null;
        }
      }
      const plannedRows = prepareMigrateRowPlan({
        migrationConfig: migration,
        sourceRowCountTotal,
        offset,
        indexLimited: idx.indexLimited,
        sourceIndexFrom: idx.sourceIndexFrom,
        sourceIndexTo: idx.sourceIndexTo,
      });
      let progressTotal =
        readSourceCountCap(migration) ?? sourceRowCountTotal ?? plannedRows ?? null;
      let plannedChunks =
        plannedRows != null && plannedRows > 0
          ? Math.ceil(plannedRows / batchSize)
          : null;
      if (plannedChunks != null) {
        console.error(
          `>>> [${KEY}] plan: ${plannedRows} rows, ~${plannedChunks} chunks`,
        );
      }
      const repairRun = prepareRepairRun(
        migration,
        logsDir,
        REPAIR_SPEC_ULTRASOUND_CYST,
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
      if (debugLogs) {
        writeOutLine(
          `>>> [${KEY}] checkpoint start: offset=${offset}, afterExamId=${afterExamId}, afterChildId=${afterChildId}, enabled=${checkpointEnabled}, repair=${repairRun.active}`,
          uiState,
        );
      }
      const startedAt = Date.now();
      const runStartOffset = offset;
      while (true) {
        const chunkStartedAt = Date.now();
        const rowsDoneThisRun = rowsDoneInMigrateRun(offset, runStartOffset);
        const pageSize = resolvePageSize({
          batchSize,
          total: rowsDoneThisRun,
          plannedRows: plannedRowsForPageSize(plannedRows, migration, idx.indexLimited),
        });
        if (pageSize <= 0) break;
        let rows = [];
        let fetchMs = 0;

        if (repairRun.active) {
          const idBatch = takeNextRepairBatch(repairRun);
          if (!idBatch) break;
          const fetchStartedAt = Date.now();
          rows = await fetchMssqlRowsByIds(pool, sql, {
            ids: idBatch,
            detailSqlTemplate,
          });
          fetchMs = Date.now() - fetchStartedAt;
          noteRepairBatchFetch(repairRun, idBatch, rows, (r) =>
            String(r?.exam_id ?? "").trim(),
          );
          if (rows.length === 0) continue;
        } else {
          if (debugLogs && !singleLineUi) {
            writeOutLine(
              `>>> [${KEY}] fetch chunk ${chunkIndex + 1}: afterExamId=${afterExamId}, afterChildId=${afterChildId}, page=${batchSize}`,
              uiState,
            );
          }
          const fetchStartedAt = Date.now();
          const keysetResult = await queryExamChildKeysetPage(
            pool,
            sql,
            migration,
            sortBundle,
            {
              keysetSql,
              compositeKs,
              afterExamId,
              afterChildId,
              pageSize,
            },
          );
          fetchMs = Date.now() - fetchStartedAt;
          rows = keysetResult.rows;
          if (sortBundle.createdDateColumn) {
            compositeKs = keysetResult.compositeKs;
          }
          if (debugLogs && !singleLineUi) {
            writeOutLine(
              `>>> [${KEY}] fetch chunk ${chunkIndex + 1} done: rows=${rows.length}, ms=${fetchMs}`,
              uiState,
            );
          }
          if (rows.length === 0) break;
        }

        rows = trimRowsToMigrateCap(
          rows,
          rowsDoneThisRun,
          plannedRows,
          migration,
          idx.indexLimited,
        );
        if (rows.length === 0) break;
        const keysetAdvance = capAdvanceToMigratePlan(
          rows.length,
          rowsDoneThisRun,
          plannedRows,
          migration,
          idx.indexLimited,
        );
        if (keysetAdvance <= 0) break;
        if (keysetAdvance < rows.length) rows = rows.slice(0, keysetAdvance);

        chunkIndex += 1;
        const { firstKey, lastKey } = firstLastCompositeKey(
          rows,
          "exam_id",
          "described_cyst_id",
        );
        const normalized = rows.map(normalizeMssqlRow).filter(Boolean);
        const skipped = rows.length - normalized.length;

        let step = "begin";
        let txBeginMs = 0;
        let stagingMs = 0;
        let postLoadMs = 0;
        let commitMs = 0;
        try {
          step = "BEGIN";
          const txBeginStartedAt = Date.now();
          await client.query("BEGIN");
          txBeginMs = Date.now() - txBeginStartedAt;
          step = "load to staging";
          const stagingStartedAt = Date.now();
          const loaded = await loadChunkToStaging(client, normalized);
          stagingMs = Date.now() - stagingStartedAt;
          runLog.rowsLoadedToStaging += loaded;
          runLog.skipped += skipped;
          step = "post-load mapping (upsert)";
          const postLoadStartedAt = Date.now();
          await runUltrasoundCystChunkPostLoad(client);
          postLoadMs = Date.now() - postLoadStartedAt;
          const issueResult = await runCompositeStagingFieldIssuePipeline(
            client,
            rows,
            normalizeMssqlRow,
            COMPOSITE_FIELD_ISSUE.normalizeConfig,
            COMPOSITE_FIELD_ISSUE.verifyOptions,
            loaded,
          );
          mergeFieldIssueChunk(fieldIssueAcc, issueResult);
          runLog.rowsUpserted += loaded;
          step = "COMMIT";
          const commitStartedAt = Date.now();
          await client.query("COMMIT");
          commitMs = Date.now() - commitStartedAt;
        } catch (err) {
          await client.query("ROLLBACK");
          chunkLog.recordFailure({
            chunkIndex,
            failedAtStep: step,
            rowCount: rows.length,
            firstKey,
            lastKey,
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

        chunkLog.record({
          chunkIndex,
          status: "success",
          rowCount: rows.length,
          firstKey,
          lastKey,
          fetchMs,
          stagingMs,
          postLoadMs,
          chunkTotalMs: Date.now() - chunkStartedAt,
        });

        offset += rows.length;
        const last = rows[rows.length - 1];
        if (sortBundle.createdDateColumn) {
          compositeKs = advanceExamChildCompositeKeyset(last, "described_cyst_id");
        } else {
          afterExamId = Number.parseInt(last?.exam_id ?? "", 10);
          afterChildId = Number.parseInt(last?.described_cyst_id ?? "", 10);
          if (!Number.isFinite(afterExamId)) afterExamId = 0;
          if (!Number.isFinite(afterChildId)) afterChildId = 0;
        }
        if (checkpointEnabled && !repairRun.active) {
          if (sortBundle.createdDateColumn) {
            writeJson(
              checkpointPath,
              buildCreatedDateCheckpointFields(sortBundle, {
                offset,
                mssqlKeysetAfter: "",
                afterExamId: compositeKs.afterExamId,
                completed: false,
                composite: compositeKs,
                extra: { key: KEY },
              }),
            );
          } else {
            writeJson(checkpointPath, {
              key: KEY,
              offset,
              afterExamId,
              afterChildId,
              completed: false,
              updatedAt: new Date().toISOString(),
            });
          }
        }
        if (debugLogs && !singleLineUi) {
          writeOutLine(
            `>>> [${KEY}] chunk ${chunkIndex}/${plannedChunks ?? "?"} done ${formatSec(
              Date.now() - chunkStartedAt,
            )} rows=${rows.length} total=${offset}/${plannedRows ?? "?"} (fetch=${formatSec(
              fetchMs,
            )}, begin=${formatSec(txBeginMs)}, staging=${formatSec(
              stagingMs,
            )}, post=${formatSec(postLoadMs)}, commit=${formatSec(commitMs)})`,
            uiState,
          );
        }
        if (progressEnabled) {
          renderProgress(
            offset,
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
            advance: keysetAdvance,
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

      if (checkpointEnabled) {
        const migrationCheckpointComplete = shouldMarkMigrateCheckpointComplete({
          migrationConfig: migration,
          indexLimited: idx.indexLimited,
          runStartOffset,
          currentOffset: offset,
          plannedRows,
        });
        if (sortBundle.createdDateColumn) {
          writeJson(
            checkpointPath,
            buildCreatedDateCheckpointFields(sortBundle, {
              offset,
              mssqlKeysetAfter: "",
              afterExamId: compositeKs.afterExamId,
              completed: migrationCheckpointComplete,
              composite: compositeKs,
              extra: { key: KEY },
            }),
          );
        } else {
          writeJson(checkpointPath, {
            key: KEY,
            offset,
            afterExamId,
            afterChildId,
            completed: migrationCheckpointComplete,
            updatedAt: new Date().toISOString(),
          });
        }
      }
      if (progressEnabled) endProgress(uiState);

      assertMigrationReachedPlan({
        tableKey: KEY,
        currentOffset: offset,
        migrationConfig: migration,
        indexLimited: idx.indexLimited,
        progressTotal,
        plannedRows,
      });

      let fieldIssueLogWritten = null;
      if (fieldIssueAcc.totalFieldIssueCount > 0) {
        const payload = buildFieldIssueLogPayload(fieldIssueAcc, {
          migrationKey: KEY,
          logType: "ultrasound_cyst_field_issues",
          recordIdKey: "record_key",
          buildRecord: (rec) => ({
            record_key: String(rec.record_key),
            exam_id: rec.exam_id ?? null,
            described_cyst_id: rec.described_cyst_id ?? null,
            pid: rec.pid ?? null,
            fieldIssues: rec.fieldIssues ?? [],
          }),
        });
        writeFieldIssueLogFile(fieldIssueLogPath, payload);
        fieldIssueLogWritten = fieldIssueLogPath;
      }
      runLog.fieldIssueLogPath = fieldIssueLogWritten;
      runLog.repairSummary = finishRepairRunSummary(
        KEY,
        REPAIR_SPEC_ULTRASOUND_CYST,
        repairRun,
        { fieldIssueAcc },
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
