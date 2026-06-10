import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import pg from "pg";
import {
  MSSQL_EXAMINATION_GENERAL_DETAIL_BY_IDS_SELECT,
  MSSQL_EXAMINATION_GENERAL_ID_SELECT,
} from "./mssqlExaminationGeneralSelect.mjs";
import { ensureExaminationGeneralPipelineDdl } from "./examinationGeneralPgDdl.mjs";
import {
  normalizeMssqlRow,
  runExaminationGeneralChunkPostLoad,
} from "./examinationGeneralMapping.mjs";
import {
  buildFieldIssueLogPayload,
  createFieldIssueAccumulator,
  mergeFieldIssueChunk,
  writeFieldIssueLogFile,
} from "../../shared/js-migrate/fieldIssueLog.mjs";
import { runExamKeyedStagingFieldIssuePipeline } from "../../shared/js-migrate/stagingFieldIssues.mjs";
import {
  createUiState,
  endProgress,
  formatSec,
  markProgressInline,
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
} from "../../shared/js-migrate/sourceIndexRange.mjs";
import { fetchMssqlRowsByIds } from "../../shared/js-migrate/fetchMssqlByIds.mjs";
import { REPAIR_SPEC_EXAMINATION_GENERAL } from "../../shared/js-migrate/migrateTableSpecs.mjs";
import {
  finishRepairRunSummary,
  noteRepairBatchFetch,
  explicitIdsProgressPlan,
  prepareRepairRun,
  repairRunIsDone,
  repairRunIsEmpty,
  takeNextRepairBatch,
} from "../../shared/js-migrate/repairRun.mjs";

import {
  formatAdvanceLog,
  isLastKeysetPage,
} from "../../shared/js-migrate/twoStepKeyset.mjs";
import { createChunkResultsLogger } from "../../shared/js-migrate/chunkResultsLog.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = "examination_general";

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
  const cols = [
    "exam_id",
    "exam_date",
    "pid",
    "patientexamtype",
    "patientexamtype_des",
    "screening",
    "screening_des",
    "followup",
    "followup_des",
    "r_problemindicated",
    "r_problemindicated_des",
    "l_problemindicated",
    "l_problemindicated_des",
    "pe",
    "pe_des",
    "r_palpable",
    "r_palpable_des",
    "l_palpable",
    "l_palpable_des",
    "assessment_birads",
    "assessment_birads_des",
    "recommendation",
    "recommendation_des_text",
    "recommendation_followupmounths",
    "r_recommendation_coned_compression",
    "l_recommendation_coned_compression",
    "r_recommendation_spot_mag",
    "l_recommendation_spot_mag",
    "r_recommendation_mag",
    "l_recommendation_mag",
    "r_recommendation_coned_compression_des",
    "l_recommendation_coned_compression_des",
    "r_recommendation_spot_mag_des",
    "l_recommendation_spot_mag_des",
    "r_recommendation_mag_des",
    "l_recommendation_mag_des",
    "impression",
    "impression_des",
    "impression_lastexaminationdates",
    "radiologist",
    "specialcase",
    "specialcase_point",
    "specialcase_point_des",
    "specialcase_detail",
    "recommendation_followup_with",
    "isconvertfromoldsystem",
    "sub_birads",
    "followupsymptom",
    "followupmonths",
    "followupletterprintdate",
    "followup_date",
    "corrected",
    "correcteddate",
    "r_followup",
    "r_followup_des",
    "l_followup",
    "l_followup_des",
    "cosign",
  ];
  const arrays = cols.map(() => []);
  for (const r of normalizedRows) {
    if (!r) continue;
    for (let i = 0; i < cols.length; i++) {
      arrays[i].push(r[cols[i]] ?? "");
    }
  }
  if (arrays[0].length === 0) return 0;
  await pgClient.query("TRUNCATE TABLE migrate_stg.examination_general_mssql;");
  const castArgs = cols.map((_, i) => `$${i + 1}::text[]`).join(", ");
  await pgClient.query(
    `
INSERT INTO migrate_stg.examination_general_mssql (${cols.join(", ")})
SELECT * FROM unnest(${castArgs});
`.trim(),
    arrays,
  );
  return arrays[0].length;
}

async function main() {
  const configPath = path.resolve(process.cwd(), getConfigPath());
  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const config = resolveRuntimeConfig(rawConfig, "examination_general");
  const migration = mergeMigrationWithCli(config?.migration, "examination_general");
  if (config.__profileName) {
    console.error(`>>> using config profile: ${config.__profileName}`);
  }

  const sourceSchema = config.source?.schema ?? "dbo";
  const sourceTable = config.source?.table ?? "examination_general";
  const sourceObject = `${bracketIdent(sourceSchema)}.${bracketIdent(sourceTable)}`;
  const sourceObjectNoLock = `${sourceObject} WITH (NOLOCK)`;
  const probeSql = MSSQL_EXAMINATION_GENERAL_ID_SELECT.replaceAll(
    "{{sourceObject}}",
    sourceObjectNoLock,
  );
  const detailSqlTemplate =
    MSSQL_EXAMINATION_GENERAL_DETAIL_BY_IDS_SELECT.replaceAll(
      "{{sourceObject}}",
      sourceObjectNoLock,
    );

  const batchSize = Math.max(
    100,
    Math.min(5000, Number(migration.batchSize ?? 2000)),
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
  try {
    // Quick probe to separate network/login latency from first heavy fetch latency.
    const probeStartedAt = Date.now();
    await pool
      .request()
      .query(
        "SELECT TOP 1 [Exam_ID] FROM [dbo].[examination_general] ORDER BY [Exam_ID] ASC;",
      );
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
      await ensureExaminationGeneralPipelineDdl(client);
      if (debugLogs) {
        writeOutLine(
          `>>> [${KEY}] ensure pipeline DDL in ${formatSec(Date.now() - ensureDdlStartedAt)}`,
          uiState,
        );
      }
      console.error(`>>> [${KEY}] source: ${sourceObject}`);
      console.error(
        `>>> [${KEY}] target: ${config.target.postgresDatabase} public.examination_general (batchSize=${batchSize})`,
      );

      let offset = Number(checkpointEnabled ? checkpoint.offset : 0);
      if (!Number.isFinite(offset) || offset < 0) offset = 0;
      const idx = applySourceIndexToMigrateJob({
        key: KEY,
        migrationConfig: migration,
        checkpointEnabled,
        offset,
        useMssqlKeyset: true,
      });
      offset = idx.offset;
      let afterExamId = Number(checkpointEnabled ? checkpoint.afterExamId : 0);
      if (!Number.isFinite(afterExamId) || afterExamId < 0) afterExamId = 0;
      const fieldIssueAcc = createFieldIssueAccumulator("exam_id");
      const fieldIssueLogPath = path.join(
        logsDir,
        `migration-field-issues-examination_general-${nowStamp()}.json`,
      );
      let chunkIndex = 0;
      let plannedRows = null;
      if (progressEnabled) {
        try {
          const countRes = await pool
            .request()
            .query(`SELECT COUNT_BIG(1) AS total FROM ${sourceObjectNoLock};`);
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
      if (plannedChunks != null) {
        console.error(
          `>>> [${KEY}] plan: ${plannedRows} rows, ~${plannedChunks} chunks`,
        );
      }
      const repairRun = prepareRepairRun(
        migration,
        logsDir,
        REPAIR_SPEC_EXAMINATION_GENERAL,
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
          `>>> [${KEY}] checkpoint start: offset=${offset}, afterExamId=${afterExamId}, enabled=${checkpointEnabled}, repair=${repairRun.active}`,
          uiState,
        );
      }
      const startedAt = Date.now();
      while (true) {
        const chunkStartedAt = Date.now();
        const rowsInIndexWindow = Math.max(0, offset - idx.indexStartOffset);
        const pageSize = resolvePageSize({
          batchSize,
          total: rowsInIndexWindow,
          plannedRows: idx.indexLimited ? plannedRows : null,
        });
        if (pageSize <= 0) break;
        /** @type {string[]} */
        let ids = [];
        let rows = [];
        let fetchMs = 0;
        let probeMs = 0;
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
        } else {
          if (debugLogs && !singleLineUi) {
            writeOutLine(
              `>>> [${KEY}] fetch chunk ${chunkIndex + 1}: afterExamId=${afterExamId}, page=${batchSize}`,
              uiState,
            );
          }
          const probeStartedAt = Date.now();
          const probeReq = pool.request();
          bindMigrateSrcNumericRange(probeReq, migration, sql);
          const idRes = await probeReq
            .input("afterExamId", sql.BigInt, afterExamId)
            .input("page", sql.Int, pageSize)
            .query(probeSql);
          probeMs = Date.now() - probeStartedAt;
          const idRows = idRes.recordset || [];
          ids = idRows
            .map((r) => Number.parseInt(r?.exam_id ?? "", 10))
            .filter((v) => Number.isFinite(v))
            .map(String);
          if (debugLogs && !singleLineUi) {
            writeOutLine(
              `>>> [${KEY}] probe chunk ${chunkIndex + 1} done: ids=${ids.length}, ms=${probeMs}`,
              uiState,
            );
          }
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
          detailMs = Date.now() - detailStartedAt;
          fetchMs = probeMs + detailMs;
          rows = detailRes.recordset || [];
        }
        if (debugLogs && !singleLineUi) {
          writeOutLine(
            `>>> [${KEY}] fetch chunk ${chunkIndex + 1} done: rows=${rows.length}, ms=${fetchMs} (probe=${probeMs}, detail=${detailMs})`,
            uiState,
          );
        }
        if (rows.length === 0) break;

        chunkIndex += 1;
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
          await runExaminationGeneralChunkPostLoad(client);
          postLoadMs = Date.now() - postLoadStartedAt;
          const issueResult = await runExamKeyedStagingFieldIssuePipeline(
            client,
            rows,
            normalizeMssqlRow,
            {
              recordIdKey: "exam_id",
              getRecordIdFromRaw: (r) => r?.exam_id ?? r?.Exam_ID,
              getRecordIdFromNorm: (n) => n.exam_id,
              timestampFields: [
                "exam_date",
                "followupletterprintdate",
                "followup_date",
                "correcteddate",
              ],
              buildMeta: (raw, norm) => ({
                pid: norm?.pid ?? raw?.pid ?? null,
              }),
            },
            {
              recordIdKey: "exam_id",
              targetTable: "examination_general",
              stagingFromClause: "migrate_stg.examination_general_mssql",
              buildMeta: (r) => ({ pid: r.pid ?? null }),
            },
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
          fetchMs,
          stagingMs,
          postLoadMs,
          chunkTotalMs: Date.now() - chunkStartedAt,
        });

        const keysetAdvance = ids.length;
        if (!repairRun.active) {
          offset += keysetAdvance;
          if (ids.length > 0) {
            afterExamId = Number.parseInt(ids[ids.length - 1], 10) || afterExamId;
          }
        }
        if (checkpointEnabled && !repairRun.active) {
          writeJson(checkpointPath, {
            key: KEY,
            offset,
            afterExamId,
            completed: false,
            updatedAt: new Date().toISOString(),
          });
        }
        if (debugLogs && !singleLineUi) {
          writeOutLine(
            `>>> [${KEY}] chunk ${chunkIndex}/${plannedChunks ?? "?"} done ${formatSec(
              Date.now() - chunkStartedAt,
            )} ${formatAdvanceLog(keysetAdvance, rows.length)} total=${offset}/${plannedRows ?? "?"} (fetch=${formatSec(
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
          isIndexWindowComplete({
            indexLimited: idx.indexLimited,
            plannedRows,
            rowsReadInWindow: Math.max(0, offset - idx.indexStartOffset),
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

      let fieldIssueLogWritten = null;
      if (fieldIssueAcc.totalFieldIssueCount > 0) {
        const payload = buildFieldIssueLogPayload(fieldIssueAcc, {
          migrationKey: KEY,
          logType: "examination_general_field_issues",
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
        REPAIR_SPEC_EXAMINATION_GENERAL,
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
