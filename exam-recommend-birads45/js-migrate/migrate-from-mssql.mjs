import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import pg from "pg";
import { createMssqlExamRecommendBirads45SelectBundle } from "./mssqlExamRecommendBirads45Select.mjs";
import {
  setupCreatedDateMigrationSort,
  initCreatedDateKeysetState,
} from "../../shared/js-migrate/setupCreatedDateMigrationSort.mjs";
import {
  bindCreatedDateOrNumericKeyset,
  advanceCreatedDateKeysetFromProbe,
  buildCreatedDateCheckpointFields,
} from "../../shared/js-migrate/createdDateKeysetFetch.mjs";
import { ensureExamRecommendBirads45PipelineDdl } from "./examRecommendBirads45PgDdl.mjs";
import {
  loadChunkToStaging,
  normalizeMssqlRow,
  runExamRecommendBirads45ChunkPostLoad,
} from "./examRecommendBirads45Mapping.mjs";
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
  applySourceIndexToMigrateJob,
  buildIndexCheckpointSuffix,
  isIndexWindowComplete,
  narrowPlannedRowsForIndex,
  resolvePageSize,
  plannedRowsForPageSize,
  trimRowsToMigrateCap,
  capAdvanceToMigratePlan,
  shouldStopMigratePagination,
  rowsDoneInMigrateRun,
  shouldMarkMigrateCheckpointComplete,
} from "../../shared/js-migrate/sourceIndexRange.mjs";
import { prepareMigrateRowPlan } from "../../shared/js-migrate/sourceCountSnapshot.mjs";
import { fetchMssqlRowsByIds } from "../../shared/js-migrate/fetchMssqlByIds.mjs";
import { REPAIR_SPEC_EXAM_RECOMMEND_BIRADS45 } from "../../shared/js-migrate/migrateTableSpecs.mjs";
import {
  finishRepairRunSummary,
  noteRepairBatchFetch,
  explicitIdsProgressPlan,
  prepareRepairRun,
  repairRunIsDone,
  repairRunIsEmpty,
  takeNextRepairBatch,
} from "../../shared/js-migrate/repairRun.mjs";
import { formatAdvanceLog } from "../../shared/js-migrate/twoStepKeyset.mjs";
import { createChunkResultsLogger } from "../../shared/js-migrate/chunkResultsLog.mjs";
import {
  buildFieldIssueLogPayload,
  createFieldIssueAccumulator,
  mergeFieldIssueChunk,
  writeFieldIssueLogFile,
} from "../../shared/js-migrate/fieldIssueLog.mjs";
import { runExamRecommendBirads45StagingFieldIssuePipeline } from "../../shared/js-migrate/stagingFieldIssues.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = "exam_recommend_birads45";

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

async function main() {
  const configPath = path.resolve(process.cwd(), getConfigPath());
  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const config = resolveRuntimeConfig(rawConfig, KEY);
  const migration = mergeMigrationWithCli(config?.migration, KEY);
  if (config.__profileName) {
    console.error(`>>> using config profile: ${config.__profileName}`);
  }

  const sourceSchema = config.source?.schema ?? "dbo";
  const sourceTable = config.source?.table ?? "EXAM_Recommend_BIRADS45";
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
    rowsUpdated: 0,
    examsProcessed: 0,
    examsMissingTarget: 0,
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
    completed: false,
    updatedAt: null,
  });

  const mssqlConfig = buildMssqlConfig(config.source);
  const pool = await sql.connect(mssqlConfig);
  try {
    const sortBundle = await setupCreatedDateMigrationSort(pool, {
      migrationConfig: migration,
      sourceSchema,
      sourceTable,
      tableLabel: KEY,
      createSelectBundle: createMssqlExamRecommendBirads45SelectBundle,
    });
    const probeSql = sortBundle.idProbeSql.replaceAll(
      "{{sourceObject}}",
      sourceObjectNoLock,
    );
    const detailSqlTemplate = sortBundle.detailByIdsSql.replaceAll(
      "{{sourceObject}}",
      sourceObjectNoLock,
    );

    const client = await pgPool.connect();
    try {
      await ensureExamRecommendBirads45PipelineDdl(client);
      console.error(`>>> [${KEY}] source: ${sourceObject}`);
      console.error(
        `>>> [${KEY}] target: ${config.target.postgresDatabase} public.examination_general.recommendation_des (update-only, batchSize=${batchSize})`,
      );

      const keysetState = initCreatedDateKeysetState(
        checkpoint,
        checkpointEnabled,
        sortBundle,
      );
      let offset = keysetState.offset;
      let afterExamId = keysetState.numericAfter;
      let mssqlKeysetAfter = keysetState.mssqlKeysetAfter;
      if (keysetState.sortKeyVersionUpgraded && checkpointEnabled) {
        writeJson(
          checkpointPath,
          buildCreatedDateCheckpointFields(sortBundle, {
            offset: 0,
            mssqlKeysetAfter: "",
            afterExamId: 0,
            completed: false,
            extra: { key: KEY },
          }),
        );
      }
      const idx = applySourceIndexToMigrateJob({
        key: KEY,
        migrationConfig: migration,
        checkpointEnabled,
        offset,
        useMssqlKeyset: true,
      });
      offset = idx.offset;

      const fieldIssueAcc = createFieldIssueAccumulator("exam_id");
      const fieldIssueLogPath = path.join(
        logsDir,
        `migration-field-issues-exam_recommend_birads45-${nowStamp()}.json`,
      );

      let chunkIndex = 0;
      let sourceRowCountTotal = null;
      if (progressEnabled) {
        try {
          const countRes = await pool.request().query(`
SELECT COUNT_BIG(DISTINCT [Exam_ID]) AS total
FROM ${sourceObjectNoLock};`);
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
      let progressTotal = plannedRows ?? null;
      let plannedChunks =
        plannedRows != null && plannedRows > 0
          ? Math.ceil(plannedRows / batchSize)
          : null;
      if (plannedChunks != null) {
        console.error(
          `>>> [${KEY}] plan: ${plannedRows} exams, ~${plannedChunks} chunks`,
        );
      }

      const repairRun = prepareRepairRun(
        migration,
        logsDir,
        REPAIR_SPEC_EXAM_RECOMMEND_BIRADS45,
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
      while (true) {
        const chunkStartedAt = Date.now();
        const rowsDoneThisRun = rowsDoneInMigrateRun(offset, runStartOffset);
        const pageSize = resolvePageSize({
          batchSize,
          total: rowsDoneThisRun,
          plannedRows: plannedRowsForPageSize(plannedRows, migration, idx.indexLimited),
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
          noteRepairBatchFetch(repairRun, ids, rows, (r) =>
            String(r?.exam_id ?? r?.Exam_ID ?? "").trim(),
          );
          if (rows.length === 0) continue;
        } else {
          const probeStartedAt = Date.now();
          const probeReq = pool.request();
          bindMigrateSrcNumericRange(probeReq, migration, sql);
          bindCreatedDateOrNumericKeyset(probeReq, sql, sortBundle, {
            mssqlKeysetAfter,
            numericAfter: afterExamId,
          });
          const idRes = await probeReq
            .input("page", sql.Int, pageSize)
            .query(probeSql);
          const probeMs = Date.now() - probeStartedAt;
          const idRows = idRes.recordset || [];
          const advanced = advanceCreatedDateKeysetFromProbe(
            idRows,
            sortBundle,
            { numericAfter: afterExamId, mssqlKeysetAfter },
          );
          afterExamId = advanced.numericAfter;
          mssqlKeysetAfter = advanced.mssqlKeysetAfter;
          ids = idRows
            .map((r) => Number.parseInt(r?.exam_id ?? "", 10))
            .filter((v) => Number.isFinite(v))
            .map(String);
          if (ids.length === 0) break;

          const idPlaceholders = ids.map((_, i) => `@id${i}`).join(", ");
          const detailSql = detailSqlTemplate.replace(
            "{{idPlaceholders}}",
            idPlaceholders,
          );
          const detailReq = pool.request();
          ids.forEach((id, i) => detailReq.input(`id${i}`, sql.BigInt, id));
          const detailStartedAt = Date.now();
          const detailRes = await detailReq.query(detailSql);
          fetchMs = probeMs + (Date.now() - detailStartedAt);
          rows = detailRes.recordset || [];
        }
        if (rows.length === 0) break;

        rows = trimRowsToMigrateCap(
          rows,
          rowsDoneThisRun,
          plannedRows,
          migration,
          idx.indexLimited,
        );
        if (rows.length === 0) break;
        if (ids.length > rows.length) ids = ids.slice(0, rows.length);

        chunkIndex += 1;
        const normalized = rows.map(normalizeMssqlRow).filter(Boolean);
        const skipped = rows.length - normalized.length;

        let step = "begin";
        /** @type {{ rowsUpdated?: number, examsProcessed?: number, examsMissingTarget?: number }} */
        let postResult = {};
        try {
          step = "BEGIN";
          await client.query("BEGIN");
          step = "load to staging";
          const loaded = await loadChunkToStaging(client, normalized);
          runLog.rowsLoadedToStaging += loaded;
          runLog.skipped += skipped;
          step = "post-load mapping (update recommendation_des)";
          postResult = await runExamRecommendBirads45ChunkPostLoad(client);
          runLog.rowsUpdated += postResult.rowsUpdated ?? 0;
          runLog.examsProcessed += postResult.examsProcessed ?? 0;
          runLog.examsMissingTarget += postResult.examsMissingTarget ?? 0;
          const issueResult = await runExamRecommendBirads45StagingFieldIssuePipeline(
            client,
            rows,
            normalizeMssqlRow,
            normalized.length,
          );
          mergeFieldIssueChunk(fieldIssueAcc, issueResult);
          step = "COMMIT";
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          chunkLog.recordFailure({
            chunkIndex,
            failedAtStep: step,
            rowCount: ids.length,
            rowsFetched: rows.length,
            firstExamId: ids[0] ?? null,
            lastExamId: ids.length > 0 ? ids[ids.length - 1] : null,
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
          rowCount: ids.length,
          rowsFetched: rows.length,
          firstExamId: ids[0] ?? null,
          lastExamId: ids.length > 0 ? ids[ids.length - 1] : null,
          rowsUpdated: postResult.rowsUpdated ?? 0,
          examsProcessed: postResult.examsProcessed ?? 0,
          examsMissingTarget: postResult.examsMissingTarget ?? 0,
          fetchMs,
          chunkTotalMs: Date.now() - chunkStartedAt,
        });

        let keysetAdvance = capAdvanceToMigratePlan(
          ids.length,
          rowsDoneThisRun,
          plannedRows,
          migration,
          idx.indexLimited,
        );
        if (keysetAdvance <= 0) break;
        if (!repairRun.active) {
          offset += keysetAdvance;
        }
        if (checkpointEnabled && !repairRun.active) {
          writeJson(
            checkpointPath,
            buildCreatedDateCheckpointFields(sortBundle, {
              offset,
              mssqlKeysetAfter,
              afterExamId,
              completed: false,
              extra: { key: KEY },
            }),
          );
        }
        if (debugLogs && !singleLineUi) {
          writeOutLine(
            `>>> [${KEY}] chunk ${chunkIndex}/${plannedChunks ?? "?"} done ${formatSec(
              Date.now() - chunkStartedAt,
            )} ${formatAdvanceLog(keysetAdvance, rows.length)} total=${offset}/${plannedRows ?? "?"} fetch=${formatSec(fetchMs)}`,
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
        writeJson(
          checkpointPath,
          buildCreatedDateCheckpointFields(sortBundle, {
            offset,
            mssqlKeysetAfter,
            afterExamId,
            completed: shouldMarkMigrateCheckpointComplete({
              migrationConfig: migration,
              indexLimited: idx.indexLimited,
              runStartOffset,
              currentOffset: offset,
              plannedRows,
            }),
            extra: { key: KEY },
          }),
        );
      }
      if (progressEnabled) endProgress(uiState);

      let fieldIssueLogWritten = null;
      if (fieldIssueAcc.totalFieldIssueCount > 0) {
        const payload = buildFieldIssueLogPayload(fieldIssueAcc, {
          migrationKey: KEY,
          logType: "exam_recommend_birads45_field_issues",
          recordIdKey: "exam_id",
          buildRecord: (rec) => ({
            exam_id: String(rec.exam_id),
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
        REPAIR_SPEC_EXAM_RECOMMEND_BIRADS45,
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
