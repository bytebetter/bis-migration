import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import pg from "pg";
import {
  MSSQL_PACSSYNC_INFO_ID_SELECT_FIRST,
  MSSQL_PACSSYNC_INFO_ID_SELECT_KEYSET,
  buildMssqlPacsSyncInfoChunkSqlFirst,
  buildMssqlPacsSyncInfoChunkSqlKeyset,
  buildMssqlPacsSyncInfoDetailSql,
  buildMssqlPacsSyncInfoOffsetSql,
  buildMssqlPacsSyncInfoNullAccessionChunkSqlFirst,
  buildMssqlPacsSyncInfoNullAccessionChunkSqlKeyset,
  buildMssqlPacsSyncInfoChunkSqlFirstComposite,
  buildMssqlPacsSyncInfoChunkSqlKeysetComposite,
  PACSSYNC_ROW_FINGERPRINT_VERSION,
} from "./mssqlPacsSyncInfoSelect.mjs";
import { ensurePacsSyncInfoPipelineDdl } from "./pacsSyncInfoPgDdl.mjs";
import {
  normalizePacsSyncMssqlRow,
  resetPacsSyncInfoIdSequenceIfEmpty,
  resetPacsSyncInfoTargetColumnCache,
  runPacsSyncInfoChunkPostLoad,
  syncPacsSyncInfoIdSequence,
} from "./pacsSyncInfoMapping.mjs";
import {
  buildFieldIssueLogPayload,
  createFieldIssueAccumulator,
  mergeFieldIssueChunk,
  writeFieldIssueLogFile,
} from "../../shared/js-migrate/fieldIssueLog.mjs";
import { runPacsSyncStagingFieldIssuePipeline } from "../../shared/js-migrate/stagingFieldIssues.mjs";
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
  logByIdMigrationRun,
  plannedProgressForSourceIds,
} from "../../shared/js-migrate/sourceIdsSupport.mjs";
import {
  bindMigrateSrcNumericRange,
  logMigrationRunMode,
} from "../../shared/js-migrate/migrateCliArgs.mjs";
import {
  applySourceIndexToMigrateJob,
  buildIndexCheckpointSuffix,
  isIndexWindowComplete,
  narrowPlannedRowsForIndex,
  resolvePageSize,
} from "../../shared/js-migrate/sourceIndexRange.mjs";
import { REPAIR_SPEC_PACS_SYNC_INFO } from "../../shared/js-migrate/migrateTableSpecs.mjs";
import {
  batchIds,
  resolveMigrationSourceIds,
} from "../../shared/js-migrate/repairFromLog.mjs";
import {
  createChunkResultsLogger,
  firstLastRowField,
} from "../../shared/js-migrate/chunkResultsLog.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = "pacs_sync_info";

const STAGING_COLUMNS = [
  "accession_id",
  "pid",
  "exam_id",
  "dl_dt",
  "modality",
  "seriesperformed",
  "status",
  "isnormalstudy",
  "studyno",
  "studydescription",
  "ismarkdel",
  "pacssynctime",
  "worklistcode",
  "riscode",
  "syncfilename",
];

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

function assertMssqlSourceReady(source) {
  if (!source || source.mssqlUrl) return;
  const pw = source.password;
  if (
    pw == null ||
    String(pw).trim() === "" ||
    String(pw) === "YOUR_MSSQL_PASSWORD"
  ) {
    throw new Error(
      "MSSQL: เธเธณเธซเธเธ” source.password เนเธ migration.config.local.json เนเธซเนเน€เธเนเธเธฃเธซเธฑเธชเธเธฃเธดเธ",
    );
  }
}

function readJsonIfExists(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) return fallbackValue;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function bracketIdent(value) {
  return `[${String(value).replace(/]/g, "]]")}]`;
}

/**
 * bind เน€เธเนเธ NVarChar เน€เธชเธกเธญเธชเธณเธซเธฃเธฑเธเธเธตเธขเนเน€เธเนเธ• โ€”
 * เธ–เนเธฒเธชเนเธ BigInt เน€เธกเธทเนเธญเธเธญเธฅเธฑเธกเธเนเน€เธเนเธ varchar/nvarchar เนเธฅเนเธงเนเธเนเธเธฑเธ `Accession_ID > @p`
 * SQL Server เธเธฐเน€เธ—เธตเธขเธเนเธเธเธ•เธฑเธงเน€เธฅเธเธซเธฅเธฑเธ implicit cast เนเธกเนเธ•เธฃเธเธเธฑเธ ORDER BY เนเธเธเธเธฑเธ”เน€เธฃเธตเธขเธเธชเธ•เธฃเธดเธ
 * (เน€เธเนเธ "594341000" เธฅเธณเธ”เธฑเธเธชเธ•เธฃเธดเธเนเธซเธเนเธเธงเนเธฒ "5943407001" เนเธ•เนเธเนเธฒเธ•เธฑเธงเน€เธฅเธเธเธฅเธฑเธเธเนเธญเธขเธเธงเนเธฒ โ’ เนเธ–เธงเธซเธฒเธข ~1M)
 */
function mssqlParamForAccessionKey(value) {
  if (value == null) {
    return { type: sql.NVarChar(sql.MAX), val: "" };
  }
  const s =
    typeof value === "bigint"
      ? value.toString()
      : String(value)
          .replace(/^\uFEFF/, "")
          .trimEnd();
  return { type: sql.NVarChar(sql.MAX), val: s };
}

function accessionKeyForCheckpoint(v) {
  if (v == null) return null;
  if (typeof v === "bigint") return v.toString();
  return String(v);
}

/** เธเธฒเธเนเธซเธกเธ” TOP+JOIN โ€” เนเธเน [Accession_ID] เธ”เธดเธเธชเธณเธซเธฃเธฑเธ checkpoint */
function readCheckpointAccessionRow(row) {
  if (!row || typeof row !== "object") return undefined;
  if (Object.hasOwn(row, "__checkpoint_acc_key"))
    return row.__checkpoint_acc_key;
  const hit = Object.keys(row).find(
    (k) => k.toLowerCase() === "__checkpoint_acc_key",
  );
  return hit ? row[hit] : undefined;
}

/** เนเธ–เธงเธเธฒเธ id probe โ€” MSSQL เธชเนเธเน€เธเนเธ __acc_key */
function readIdRowAccessionKey(row) {
  if (!row || typeof row !== "object") return undefined;
  if (Object.hasOwn(row, "__acc_key")) return row.__acc_key;
  const hit = Object.keys(row).find((k) => k.toLowerCase() === "__acc_key");
  return hit ? row[hit] : undefined;
}

function rowColCi(row, name) {
  if (!row || typeof row !== "object") return undefined;
  const want = name.toLowerCase();
  const hit = Object.keys(row).find((k) => k.toLowerCase() === want);
  return hit ? row[hit] : undefined;
}

/** นับแถวต้นทาง MSSQL — total = acc + null (ใช้ sync offset/progress ให้ตรง COUNT) */
async function queryPacsSyncSourceRowCounts(pool, sourceObjectNoLock) {
  try {
    const res = await pool.request().query(`
      SELECT
        COUNT_BIG(1) AS total_n,
        SUM(CASE WHEN [Accession_ID] IS NOT NULL THEN 1 ELSE 0 END) AS acc_n,
        SUM(CASE WHEN [Accession_ID] IS NULL THEN 1 ELSE 0 END) AS null_n
      FROM ${sourceObjectNoLock};
    `);
    const row = res.recordset?.[0] ?? {};
    return {
      total: Number(row.total_n ?? 0),
      accOnly: Number(row.acc_n ?? 0),
      nullOnly: Number(row.null_n ?? 0),
    };
  } catch {
    return { total: null, accOnly: null, nullOnly: null };
  }
}

/** ค่าสำหรับ keyset เน€เธเธช Accession_ID IS NULL */
function readNullTailCheckpointFromRow(row) {
  const examRaw = rowColCi(row, "__null_ck_exam");
  const dlRaw = rowColCi(row, "__null_ck_dl");
  const pidRaw = rowColCi(row, "__null_ck_pid");
  const fpRaw = rowColCi(row, "__null_ck_fp");
  const exam =
    examRaw == null || examRaw === ""
      ? BigInt("-9223372036854775808")
      : BigInt(String(examRaw));
  const dlStr =
    dlRaw == null || String(dlRaw).trim() === ""
      ? "1753-01-01T00:00:00.000Z"
      : String(dlRaw).replace(" ", "T");
  const pid = pidRaw == null ? "" : String(pidRaw);
  if (!Buffer.isBuffer(fpRaw) || fpRaw.length === 0) {
    throw new Error(
      "null-tail: เนเธ–เธงเธชเธธเธ”เธ—เนเธฒเธขเธเธฒเธ” __null_ck_fp (Buffer) เธชเธณเธซเธฃเธฑเธ checkpoint",
    );
  }
  return { exam, dlStr, pid, fpBuf: fpRaw };
}

function parseDlForSqlParam(dlStr) {
  const d = new Date(dlStr);
  if (Number.isNaN(d.getTime())) return new Date("1753-01-01T00:00:00.000Z");
  return d;
}

function attachNullTailKeysetParams(req, ck) {
  const exam = typeof ck.exam === "bigint" ? ck.exam : BigInt(String(ck.exam));
  req.input("nullAfterExam", sql.BigInt, exam);
  req.input("nullAfterDl", sql.DateTime2, parseDlForSqlParam(ck.dlStr));
  req.input("nullAfterPid", sql.NVarChar(sql.MAX), ck.pid ?? "");
  req.input("nullAfterFp", sql.VarBinary(32), ck.fpBuf);
}

function serializeNullTailCursor(ck) {
  return {
    exam: ck.exam.toString(),
    dlStr: ck.dlStr,
    pid: ck.pid ?? "",
    fpHex: ck.fpBuf.toString("hex"),
  };
}

function deserializeNullTailCursor(raw) {
  if (raw == null || typeof raw !== "object") return null;
  const fpHex = raw.fpHex;
  if (typeof fpHex !== "string" || fpHex.length !== 64) return null;
  const fpBuf = Buffer.from(fpHex, "hex");
  if (fpBuf.length !== 32) return null;
  const exam =
    raw.exam == null || raw.exam === ""
      ? BigInt("-9223372036854775808")
      : BigInt(String(raw.exam));
  const dlStr =
    raw.dlStr == null || String(raw.dlStr).trim() === ""
      ? "1753-01-01T00:00:00.000Z"
      : String(raw.dlStr).replace(" ", "T");
  const pid = raw.pid == null ? "" : String(raw.pid);
  return { exam, dlStr, pid, fpBuf };
}

/** keyset composite เน€เธเธชเธกเธต Accession_ID (เนเธ–เธงเธชเธธเธ”เธ—เนเธฒเธขเธเธญเธ chunk) */
function readAccLegCompositeFromRow(row) {
  const accRaw = readCheckpointAccessionRow(row);
  if (accRaw == null || String(accRaw).trim() === "") {
    throw new Error(
      "acc-leg composite: เนเธ–เธงเธชเธธเธ”เธ—เนเธฒเธขเธเธฒเธ” __checkpoint_acc_key เธชเธณเธซเธฃเธฑเธ checkpoint",
    );
  }
  const examRaw = rowColCi(row, "__acc_ck_exam");
  const dlRaw = rowColCi(row, "__acc_ck_dl");
  const pidRaw = rowColCi(row, "__acc_ck_pid");
  const fpRaw = rowColCi(row, "__acc_ck_fp");
  const chkRaw = rowColCi(row, "__acc_ck_chk");
  const exam =
    examRaw == null || examRaw === ""
      ? BigInt("-9223372036854775808")
      : BigInt(String(examRaw));
  const dlStr =
    dlRaw == null || String(dlRaw).trim() === ""
      ? "1753-01-01T00:00:00.000Z"
      : String(dlRaw).replace(" ", "T");
  const pid = pidRaw == null ? "" : String(pidRaw);
  const chk =
    typeof chkRaw === "number"
      ? chkRaw
      : chkRaw == null || chkRaw === ""
        ? NaN
        : Number(chkRaw);
  if (!Number.isFinite(chk)) {
    throw new Error(
      "acc-leg composite: เนเธ–เธงเธชเธธเธ”เธ—เนเธฒเธขเธเธฒเธ” __acc_ck_chk (BINARY_CHECKSUM) เธชเธณเธซเธฃเธฑเธ checkpoint",
    );
  }
  if (!Buffer.isBuffer(fpRaw) || fpRaw.length === 0) {
    throw new Error(
      "acc-leg composite: เนเธ–เธงเธชเธธเธ”เธ—เนเธฒเธขเธเธฒเธ” __acc_ck_fp (Buffer) เธชเธณเธซเธฃเธฑเธ checkpoint",
    );
  }
  return { accRaw, exam, dlStr, pid, fpBuf: fpRaw, chk };
}

function serializeAccLegCursor(ck) {
  return {
    accRaw: accessionKeyForCheckpoint(ck.accRaw),
    exam: ck.exam.toString(),
    dlStr: ck.dlStr,
    pid: ck.pid ?? "",
    fpHex: ck.fpBuf.toString("hex"),
    chk: ck.chk,
  };
}

function deserializeAccLegCursor(raw) {
  if (raw == null || typeof raw !== "object") return null;
  const ar = raw.accRaw ?? raw.acc_raw;
  if (ar == null || String(ar).trim() === "") return null;
  const fpHex = raw.fpHex;
  if (typeof fpHex !== "string" || fpHex.length !== 64) return null;
  const fpBuf = Buffer.from(fpHex, "hex");
  if (fpBuf.length !== 32) return null;
  const chkRaw = raw.chk ?? raw.accCkChk;
  const chk =
    typeof chkRaw === "number"
      ? chkRaw
      : chkRaw == null || chkRaw === ""
        ? NaN
        : Number(chkRaw);
  if (!Number.isFinite(chk)) return null;
  const exam =
    raw.exam == null || raw.exam === ""
      ? BigInt("-9223372036854775808")
      : BigInt(String(raw.exam));
  const dlStr =
    raw.dlStr == null || String(raw.dlStr).trim() === ""
      ? "1753-01-01T00:00:00.000Z"
      : String(raw.dlStr).replace(" ", "T");
  const pid = raw.pid == null ? "" : String(raw.pid);
  return { accRaw: ar, exam, dlStr, pid, fpBuf, chk };
}

function attachAccLegCompositeParams(req, ck) {
  const pk = mssqlParamForAccessionKey(ck.accRaw);
  req.input("afterAccessionKey", pk.type, pk.val);
  const exam = typeof ck.exam === "bigint" ? ck.exam : BigInt(String(ck.exam));
  req.input("accCkAfterExam", sql.BigInt, exam);
  req.input("accCkAfterDl", sql.DateTime2, parseDlForSqlParam(ck.dlStr));
  req.input("accCkAfterPid", sql.NVarChar(sql.MAX), ck.pid ?? "");
  req.input("accCkAfterFp", sql.VarBinary(32), ck.fpBuf);
  req.input("accCkAfterChk", sql.Int, Number(ck.chk));
}

function rowToStagingArrays(rowObj, rowIdx, arrays, cols) {
  for (let c = 0; c < cols.length; c++) {
    const v = rowObj[cols[c]];
    arrays[c][rowIdx] = v === undefined || v === null ? null : String(v);
  }
}

async function loadChunkToStaging(pgClient, normalizedRows) {
  const cols = STAGING_COLUMNS;
  const arrays = cols.map(() => []);
  const n = normalizedRows.length;
  for (let i = 0; i < n; i++)
    rowToStagingArrays(normalizedRows[i], i, arrays, cols);
  if (arrays[0].length === 0) return 0;
  await pgClient.query("TRUNCATE TABLE migrate_stg.pacs_sync_info_mssql;");
  const castArgs = cols.map((_, i) => `$${i + 1}::text[]`).join(", ");
  await pgClient.query(
    `
INSERT INTO migrate_stg.pacs_sync_info_mssql (${cols.join(", ")})
SELECT * FROM unnest(${castArgs});
`.trim(),
    arrays,
  );
  return arrays[0].length;
}

function isCheckpointStart(afterAccessionId) {
  return afterAccessionId == null || String(afterAccessionId).trim() === "";
}

async function main() {
  const configPath = path.resolve(process.cwd(), getConfigPath());
  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const config = resolveRuntimeConfig(rawConfig, "pacs_sync_info");
  const migration = mergeMigrationWithCli(config?.migration, "pacs_sync_info");
  if (config.__profileName) {
    console.error(`>>> using config profile: ${config.__profileName}`);
  }

  assertMssqlSourceReady(config.source);

  resetPacsSyncInfoTargetColumnCache();

  const sourceSchema = config.source?.schema ?? "dbo";
  const sourceTable = config.source?.table ?? "pacs_sync_info";
  const sourceObject = `${bracketIdent(sourceSchema)}.${bracketIdent(sourceTable)}`;
  const sourceObjectNoLock = `${sourceObject} WITH (NOLOCK)`;

  const probeSqlFirst = MSSQL_PACSSYNC_INFO_ID_SELECT_FIRST.replaceAll(
    "{{sourceObject}}",
    sourceObjectNoLock,
  );
  const probeSqlKeyset = MSSQL_PACSSYNC_INFO_ID_SELECT_KEYSET.replaceAll(
    "{{sourceObject}}",
    sourceObjectNoLock,
  );

  const batchSize = Math.max(
    100,
    Math.min(5000, Number(migration.batchSize ?? 2000)),
  );
  const studyDescriptionRaw = migration.studyDescriptionMaxChars;
  const studyDescriptionMaxChars =
    studyDescriptionRaw === undefined || studyDescriptionRaw === null
      ? 8192
      : Number(studyDescriptionRaw);
  const mssqlOptimizeSingleQuery =
    config?.migration?.mssqlOptimizeSingleQuery !== false;

  /**
   * "keyset_plus_null" (default) = เน€เธเธชเธกเธต Accession_ID + เน€เธเธช NULL โ€” เน€เธฃเนเธงเธเธงเนเธฒ offset
   * "offset" = เธ”เธถเธเธ—เธฑเนเธเธ•เธฒเธฃเธฒเธเธ”เนเธงเธข ORDER BY + OFFSET/FETCH (เธเนเธฒเน€เธกเธทเนเธญ offset เธชเธนเธ เนเธ•เนเธฅเธณเธ”เธฑเธเธเธฑเธ”/callback เนเธ”เนเธเธฃเธเนเธ–เธง)
   * "keyset" = เน€เธเธเธฒเธฐเนเธ–เธงเธ—เธตเนเธกเธต Accession_ID
   * เธญเนเธฒเธเน€เธเธเธฒเธฐเธชเธเธฃเธดเธเธ•เน pacs โ€” เนเธเธฐเธเธณเนเธชเนเนเธ profiles.pacs_sync_info.migration เนเธกเนเนเธเน shared
   */
  const mssqlPagination =
    config?.migration?.mssqlPagination ?? "keyset_plus_null";
  let useOffsetPagination = mssqlPagination === "offset";
  const useKeysetPlusNull = mssqlPagination === "keyset_plus_null";

  const mssqlDetailInChunkSize = Math.max(
    50,
    Math.min(
      batchSize,
      Number(config?.migration?.mssqlDetailInChunkSize ?? batchSize),
    ),
  );

  const detailSqlTemplate = mssqlOptimizeSingleQuery
    ? null
    : buildMssqlPacsSyncInfoDetailSql(studyDescriptionMaxChars).replaceAll(
        "{{sourceObject}}",
        sourceObjectNoLock,
      );

  const chunkSqlOptFirst = mssqlOptimizeSingleQuery
    ? buildMssqlPacsSyncInfoChunkSqlFirst(studyDescriptionMaxChars).replaceAll(
        "{{sourceTable}}",
        sourceObject,
      )
    : null;
  const chunkSqlOptKeyset = mssqlOptimizeSingleQuery
    ? buildMssqlPacsSyncInfoChunkSqlKeyset(studyDescriptionMaxChars).replaceAll(
        "{{sourceTable}}",
        sourceObject,
      )
    : null;
  const chunkSqlOffset = useOffsetPagination
    ? buildMssqlPacsSyncInfoOffsetSql(studyDescriptionMaxChars).replaceAll(
        "{{sourceObject}}",
        sourceObjectNoLock,
      )
    : null;
  const nullAccSqlFirst =
    useKeysetPlusNull && mssqlOptimizeSingleQuery
      ? buildMssqlPacsSyncInfoNullAccessionChunkSqlFirst(
          studyDescriptionMaxChars,
        ).replaceAll("{{sourceObject}}", sourceObjectNoLock)
      : null;
  const nullAccSqlKeyset =
    useKeysetPlusNull && mssqlOptimizeSingleQuery
      ? buildMssqlPacsSyncInfoNullAccessionChunkSqlKeyset(
          studyDescriptionMaxChars,
        ).replaceAll("{{sourceObject}}", sourceObjectNoLock)
      : null;
  const chunkSqlAccCompositeFirst =
    useKeysetPlusNull && mssqlOptimizeSingleQuery
      ? buildMssqlPacsSyncInfoChunkSqlFirstComposite(
          studyDescriptionMaxChars,
        ).replaceAll("{{sourceTable}}", sourceObject)
      : null;
  const chunkSqlAccCompositeKeyset =
    useKeysetPlusNull && mssqlOptimizeSingleQuery
      ? buildMssqlPacsSyncInfoChunkSqlKeysetComposite(
          studyDescriptionMaxChars,
        ).replaceAll("{{sourceTable}}", sourceObject)
      : null;

  if (useKeysetPlusNull && !mssqlOptimizeSingleQuery) {
    console.error(
      `>>> [${KEY}] เธเธณเน€เธ•เธทเธญเธ: keyset_plus_null เนเธเนเนเธ”เนเธเธฑเธ mssqlOptimizeSingleQuery เน€เธ—เนเธฒเธเธฑเนเธ โ€” เธเธฐเนเธกเนเธฃเธฑเธเน€เธเธช null (เนเธเน offset เธซเธฃเธทเธญเน€เธเธดเธ” TOP+JOIN)`,
    );
  }

  const progressEnabled = config?.migration?.progressUi !== false;
  const singleLineUi = config?.migration?.singleLineUi !== false;
  const debugLogs = config?.migration?.debugLogs === true;

  const checkpointEnabled = config?.migration?.enableCheckpoint !== false;
  const checkpointDir = path.resolve(
    __dirname,
    config?.migration?.checkpointDir ?? "./checkpoints",
  );
  fs.mkdirSync(checkpointDir, { recursive: true });
  const indexCkSuffix = buildIndexCheckpointSuffix(migration);
  const checkpointPath = path.join(checkpointDir, `${KEY}${indexCkSuffix}.json`);
  const checkpoint = readJsonIfExists(checkpointPath, {
    key: KEY,
    offset: 0,
    afterAccessionId: null,
    completed: false,
    nullTailDone: false,
    migrationLeg: "acc",
    nullTailCursor: null,
    accLegCursor: null,
    accFingerprintVersion: null,
    updatedAt: null,
  });

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
    studyDescriptionMaxChars,
    mssqlDetailInChunkSize,
    mssqlOptimizeSingleQuery,
    mssqlPagination,
    mssqlAccComposite: useKeysetPlusNull && mssqlOptimizeSingleQuery,
    migrationLeg: null,
    nullTailDone: null,
    rowsLoadedToStaging: 0,
    rowsUpserted: 0,
    skipped: 0,
    error: null,
    plannedRows: null,
    plannedChunks: null,
  };
  const chunkLog = createChunkResultsLogger(migration);

  const mssqlConfig = buildMssqlConfig(config.source);
  let mssqlServerHint = config.source?.server ?? "?";
  if (mssqlServerHint === "?" && config.source?.mssqlUrl) {
    try {
      const u = new URL(
        config.source.mssqlUrl.replace(/^microsoftsqlserver:\/\//i, "mssql://"),
      );
      mssqlServerHint = u.hostname || "?";
    } catch {
      mssqlServerHint = "(invalid mssqlUrl)";
    }
  }
  const mssqlConnectStartedAt = Date.now();
  const pool = await sql.connect(mssqlConfig);
  if (debugLogs) {
    writeOutLine(
      `>>> [${KEY}] MSSQL connected in ${formatSec(Date.now() - mssqlConnectStartedAt)} (${mssqlServerHint})`,
      uiState,
    );
  }

  const isResumeRun =
    String(migration.migrateRunMode ?? "resume").toLowerCase() === "resume";
  let dailyCatchUpReset = false;

  try {
    if (
      checkpointEnabled &&
      checkpoint.completed === true &&
      checkpoint.nullTailDone === true
    ) {
      if (isResumeRun) {
        dailyCatchUpReset = true;
        console.error(
          `>>> [${KEY}] resume catch-up: สแกน MSSQL ใหม่ทั้งตาราง (upsert ตาม accession_id — progress นับแถวต้นทางให้ตรง COUNT)`,
        );
      } else {
        runLog.status = "skipped";
        runLog.migrationLeg = checkpoint.migrationLeg ?? "done";
        runLog.nullTailDone = true;
        console.error(
          `>>> [${KEY}] checkpoint: ข้ามครบแล้ว (รวมแถว Accession_ID NULL) — ไม่รันซ้ำ (migrateRunMode ไม่ใช่ resume)`,
        );
        chunkLog.attachTo(runLog);
        return;
      }
    }

    const probeStartedAt = Date.now();
    await pool
      .request()
      .query(
        `SELECT TOP 1 [Accession_ID] FROM ${sourceObjectNoLock} ORDER BY [Accession_ID] ASC;`,
      );
    if (debugLogs) {
      writeOutLine(
        `>>> [${KEY}] MSSQL probe done in ${formatSec(Date.now() - probeStartedAt)}`,
        uiState,
      );
    }

    const pgHost = config.target?.postgresHost ?? "127.0.0.1";
    const pgPort = Number(config.target?.postgresPort ?? 5432);
    const pgConnectStartedAt = Date.now();
    const client = await pgPool.connect();
    if (debugLogs) {
      writeOutLine(
        `>>> [${KEY}] Postgres connected in ${formatSec(Date.now() - pgConnectStartedAt)} to ${pgHost}:${pgPort} (${config.target?.postgresDatabase ?? "bisinfo_dev_clone"})`,
        uiState,
      );
    }
    try {
      const ddlStartedAt = Date.now();
      await ensurePacsSyncInfoPipelineDdl(client);
      await resetPacsSyncInfoIdSequenceIfEmpty(client);
      if (debugLogs) {
        writeOutLine(
          `>>> [${KEY}] ensure pipeline DDL in ${formatSec(Date.now() - ddlStartedAt)}`,
          uiState,
        );
      }

      console.error(`>>> [${KEY}] source: ${sourceObject}`);
      let fetchModeLabel = ", probe+IN";
      if (useOffsetPagination) fetchModeLabel = ", OFFSET";
      else if (useKeysetPlusNull && mssqlOptimizeSingleQuery) {
        fetchModeLabel = ", TOP+JOIN(composite)+null-tail";
      } else if (mssqlOptimizeSingleQuery) {
        fetchModeLabel = ", TOP+JOIN";
      }
      console.error(
        `>>> [${KEY}] target: ${config.target.postgresDatabase} public.pacs_sync_info (batchSize=${batchSize}${fetchModeLabel})`,
      );
      logMigrationRunMode(migration, KEY);
      if (debugLogs && !singleLineUi) {
        const sdHint =
          !Number.isFinite(studyDescriptionMaxChars) ||
          studyDescriptionMaxChars <= 0
            ? "StudyDescription เน€เธ•เนเธก MAX"
            : `StudyDescription โค${studyDescriptionMaxChars}`;
        writeOutLine(
          `>>> [${KEY}] options: ${sdHint}; PG indexes เธเธฒเธ DDL; mssqlDetailInChunkSize=${mssqlDetailInChunkSize}`,
          uiState,
        );
      }

      /** แถวที่ดึงจาก MSSQL แล้ว (สะสม acc + null-tail) — ใช้แสดง progress ให้ตรง COUNT */
      let rowsProcessed = Number(checkpointEnabled ? checkpoint.offset : 0);
      if (!Number.isFinite(rowsProcessed) || rowsProcessed < 0) {
        rowsProcessed = 0;
      }
      if (dailyCatchUpReset) {
        rowsProcessed = 0;
      }
      let offset = rowsProcessed;
      const idx = applySourceIndexToMigrateJob({
        key: KEY,
        migrationConfig: migration,
        checkpointEnabled,
        offset,
        useMssqlKeyset: true,
      });
      offset = idx.offset;
      if (idx.indexLimited && idx.indexStartOffset > 0) {
        useOffsetPagination = true;
      }
      const fieldIssueAcc = createFieldIssueAccumulator("accession_id");
      const fieldIssueLogPath = path.join(
        logsDir,
        `migration-field-issues-pacs_sync_info-${nowStamp()}.json`,
      );

      const repairSourceIds = resolveMigrationSourceIds(
        migration,
        logsDir,
        REPAIR_SPEC_PACS_SYNC_INFO,
      );
      if (repairSourceIds != null) {
        if (repairSourceIds.length === 0) {
          console.error(`>>> [${KEY}] repair-from-log: ไม่มี id ให้ migrate`);
        } else {
          logByIdMigrationRun(
            KEY,
            repairSourceIds.length,
            "accession_id",
            migration,
          );
          const repairDetailTpl =
            detailSqlTemplate ??
            buildMssqlPacsSyncInfoDetailSql(
              studyDescriptionMaxChars,
            ).replaceAll("{{sourceObject}}", sourceObjectNoLock);
          let repairOffset = 0;
          let repairChunkIndex = 0;
          const repairStartedAt = Date.now();
          for (const accBatch of batchIds(repairSourceIds, batchSize)) {
            let rows = [];
            const sliceCount = Math.max(
              1,
              Math.ceil(accBatch.length / mssqlDetailInChunkSize),
            );
            for (let s = 0; s < sliceCount; s++) {
              const lo = s * mssqlDetailInChunkSize;
              const slice = accBatch.slice(lo, lo + mssqlDetailInChunkSize);
              if (slice.length === 0) break;
              const idPlaceholders = slice.map((_, i) => `@id${i}`).join(", ");
              const detailSql = repairDetailTpl.replaceAll(
                "{{idPlaceholders}}",
                idPlaceholders,
              );
              const detailReq = pool.request();
              slice.forEach((key, i) => {
                const pk = mssqlParamForAccessionKey(key);
                detailReq.input(`id${i}`, pk.type, pk.val);
              });
              const detailRes = await detailReq.query(detailSql);
              rows.push(...(detailRes.recordset || []));
            }
            if (rows.length === 0) continue;

            repairChunkIndex += 1;
            const normalized = rows.map((r, i) =>
              normalizePacsSyncMssqlRow(r, repairOffset + i),
            );
            const skipped = rows.length - normalized.length;

            let step = "begin";
            try {
              step = "BEGIN";
              await client.query("BEGIN");
              step = "load to staging";
              const loaded = await loadChunkToStaging(client, normalized);
              runLog.rowsLoadedToStaging += loaded;
              runLog.skipped += skipped;
              step = "post-load (pacs_sync_info)";
              await runPacsSyncInfoChunkPostLoad(client);
              const issueResult = await runPacsSyncStagingFieldIssuePipeline(
                client,
                rows,
                (r, i) => normalizePacsSyncMssqlRow(r, repairOffset + i),
                "migrate_stg.pacs_sync_info_mssql",
                loaded,
              );
              mergeFieldIssueChunk(fieldIssueAcc, issueResult);
              runLog.rowsUpserted += loaded;
              step = "COMMIT";
              await client.query("COMMIT");
            } catch (err) {
              await client.query("ROLLBACK");
              throw new Error(
                `[${KEY}] repair failed chunk ${repairChunkIndex} at step '${step}': ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }

            repairOffset += rows.length;
            if (progressEnabled) {
              renderProgress(
                repairOffset,
                repairSourceIds.length,
                repairStartedAt,
                repairChunkIndex,
                Math.ceil(repairSourceIds.length / batchSize),
                uiState,
              );
            }
          }
          if (progressEnabled) endProgress(uiState);
          await syncPacsSyncInfoIdSequence(client);
        }

        let fieldIssueLogWritten = null;
        if (fieldIssueAcc.totalFieldIssueCount > 0) {
          const payload = buildFieldIssueLogPayload(fieldIssueAcc, {
            migrationKey: KEY,
            logType: "pacs_sync_info_field_issues",
            recordIdKey: "accession_id",
            buildRecord: (rec) => ({
              accession_id: String(rec.accession_id),
              pid: rec.pid ?? null,
              fieldIssues: rec.fieldIssues ?? [],
            }),
          });
          writeFieldIssueLogFile(fieldIssueLogPath, payload);
          fieldIssueLogWritten = fieldIssueLogPath;
        }
        runLog.fieldIssueLogPath = fieldIssueLogWritten;
        runLog.status = "success";
        return;
      }

      if (!Number.isFinite(offset) || offset < 0) {
        offset = 0;
        rowsProcessed = 0;
      }
      let afterAccessionId =
        checkpointEnabled && checkpoint.afterAccessionId != null
          ? String(checkpoint.afterAccessionId)
          : null;

      let migrationLeg =
        checkpointEnabled && checkpoint.migrationLeg != null
          ? String(checkpoint.migrationLeg)
          : "acc";
      let nullTailCursor = deserializeNullTailCursor(
        checkpointEnabled ? checkpoint.nullTailCursor : null,
      );
      let accLegCursor = deserializeAccLegCursor(
        checkpointEnabled ? checkpoint.accLegCursor : null,
      );

      if (checkpointEnabled) {
        const ckMode = checkpoint.mssqlPagination;
        if (ckMode != null && ckMode !== mssqlPagination) {
          offset = 0;
          rowsProcessed = 0;
          afterAccessionId = null;
          migrationLeg = "acc";
          nullTailCursor = null;
          accLegCursor = null;
          console.error(
            `>>> [${KEY}] เน€เธเธฅเธตเนเธขเธ mssqlPagination (${ckMode} -> ${mssqlPagination}) โ€” เธฃเธตเน€เธเนเธ•เธ•เธณเนเธซเธเนเธ checkpoint`,
          );
        } else if (useOffsetPagination && ckMode == null) {
          offset = 0;
          rowsProcessed = 0;
          afterAccessionId = null;
          migrationLeg = "acc";
          nullTailCursor = null;
          accLegCursor = null;
          console.error(
            `>>> [${KEY}] เนเธซเธกเธ” offset: checkpoint เน€เธเนเธฒเนเธกเนเธกเธต mssqlPagination โ€” เน€เธฃเธดเนเธกเธ—เธตเน offset 0`,
          );
        }
      }

      const ckFpVer = checkpoint.accFingerprintVersion;
      const fpVerMismatch =
        useKeysetPlusNull &&
        mssqlOptimizeSingleQuery &&
        chunkSqlAccCompositeFirst != null &&
        migrationLeg === "acc" &&
        Number(ckFpVer) !== PACSSYNC_ROW_FINGERPRINT_VERSION;

      if (fpVerMismatch) {
        offset = 0;
        rowsProcessed = 0;
        afterAccessionId = null;
        accLegCursor = null;
        nullTailCursor = null;
      }

      if (dailyCatchUpReset) {
        offset = 0;
        rowsProcessed = 0;
        afterAccessionId = null;
        migrationLeg = "acc";
        nullTailCursor = null;
        accLegCursor = null;
      }

      if (
        checkpointEnabled &&
        useKeysetPlusNull &&
        mssqlOptimizeSingleQuery &&
        chunkSqlAccCompositeFirst != null &&
        migrationLeg === "acc" &&
        !fpVerMismatch &&
        checkpoint.accLegCursor == null &&
        (offset > 0 ||
          (afterAccessionId != null && String(afterAccessionId).trim() !== ""))
      ) {
        offset = 0;
        rowsProcessed = 0;
        afterAccessionId = null;
        accLegCursor = null;
        nullTailCursor = null;
        console.error(
          `>>> [${KEY}] keyset composite: checkpoint ไม่มี accLegCursor — รีเซ็ตเฟส 1 (ดึงซ้ำ Accession ครบ)`,
        );
      }

      const onlyNullTail =
        !dailyCatchUpReset &&
        useKeysetPlusNull &&
        mssqlOptimizeSingleQuery &&
        nullAccSqlFirst != null &&
        checkpointEnabled &&
        (migrationLeg === "null_acc" ||
          (checkpoint.completed === true && checkpoint.nullTailDone !== true));

      if (onlyNullTail) {
        console.error(
          `>>> [${KEY}] เธฃเธฑเธเน€เธเธเธฒเธฐเน€เธเธชเนเธ–เธง Accession_ID NULL (เธเนเธฒเธกเน€เธเธชเธกเธต Accession_ID)`,
        );
      }

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
      runLog.plannedRows = plannedRows;
      let progressTotal = plannedRows ?? null;
      const plannedChunks =
        plannedRows != null && plannedRows > 0
          ? Math.ceil(plannedRows / batchSize)
          : null;
      runLog.plannedChunks = plannedChunks;
      if (plannedChunks != null) {
        console.error(
          `>>> [${KEY}] plan: ${plannedRows} rows, ~${plannedChunks} chunks`,
        );
      }
      if (debugLogs && !singleLineUi) {
        writeOutLine(
          `>>> [${KEY}] checkpoint: offset=${offset}, afterAccessionId=${afterAccessionId ?? "(start)"}`,
          uiState,
        );
      }

      const startedAt = Date.now();

      const useCompositeAcc =
        useKeysetPlusNull &&
        mssqlOptimizeSingleQuery &&
        chunkSqlAccCompositeFirst != null &&
        chunkSqlAccCompositeKeyset != null;

      if (!onlyNullTail) {
        while (true) {
          const chunkStartedAt = Date.now();
          const rowsInIndexWindow = Math.max(0, offset - idx.indexStartOffset);
          const pageSize = resolvePageSize({
            batchSize,
            total: rowsInIndexWindow,
            plannedRows: idx.indexLimited ? plannedRows : null,
          });
          if (pageSize <= 0) break;
          const useStartSqlAcc = useCompositeAcc
            ? accLegCursor == null
            : isCheckpointStart(afterAccessionId);
          const nextProbeLabel = chunkIndex + 1;

          if (debugLogs && !singleLineUi) {
            writeOutLine(
              useCompositeAcc
                ? `>>> [${KEY}] fetch chunk ${nextProbeLabel}: composite acc leg, page=${pageSize}, start=${useStartSqlAcc}`
                : `>>> [${KEY}] fetch chunk ${nextProbeLabel}: afterAccessionId=${afterAccessionId ?? "(start)"}, page=${pageSize}, start=${useStartSqlAcc}`,
              uiState,
            );
          }

          /** @type {Record<string, any>[]} */
          let rows = [];
          let probeMs = 0;
          let detailMs = 0;
          /** @type {unknown[]} */
          let accRawKeys = [];
          let fetchMs = 0;

          if (useOffsetPagination && chunkSqlOffset) {
            const offReq = pool
              .request()
              .input("page", sql.Int, pageSize)
              .input("offset", sql.Int, offset);
            bindMigrateSrcNumericRange(offReq, migration, sql);
            const tOff = Date.now();
            const offRes = await offReq.query(chunkSqlOffset);
            fetchMs = Date.now() - tOff;
            rows = offRes.recordset || [];
            probeMs = 0;
            detailMs = fetchMs;
            if (debugLogs && !singleLineUi) {
              writeOutLine(
                `>>> [${KEY}] fetch chunk ${nextProbeLabel} OFFSET: offset=${offset}, rows=${rows.length}, ms=${fetchMs}`,
                uiState,
              );
            }
          } else if (useCompositeAcc) {
            const joinReq = pool.request().input("page", sql.Int, pageSize);
            bindMigrateSrcNumericRange(joinReq, migration, sql);
            if (!useStartSqlAcc) {
              attachAccLegCompositeParams(joinReq, accLegCursor);
            }
            const sqlCh = useStartSqlAcc
              ? chunkSqlAccCompositeFirst
              : chunkSqlAccCompositeKeyset;
            const tJoin = Date.now();
            const joinRes = await joinReq.query(sqlCh);
            fetchMs = Date.now() - tJoin;
            rows = joinRes.recordset || [];
            probeMs = 0;
            detailMs = fetchMs;
            if (debugLogs && !singleLineUi) {
              writeOutLine(
                `>>> [${KEY}] fetch chunk ${nextProbeLabel} TOP+JOIN+composite: rows=${rows.length}, ms=${fetchMs}${useStartSqlAcc ? " (เธเธฒเธเธ•เนเธ)" : ""}`,
                uiState,
              );
            }
          } else if (
            mssqlOptimizeSingleQuery &&
            chunkSqlOptFirst &&
            chunkSqlOptKeyset
          ) {
            const joinReq = pool.request().input("page", sql.Int, pageSize);
            bindMigrateSrcNumericRange(joinReq, migration, sql);
            if (!useStartSqlAcc) {
              const pk = mssqlParamForAccessionKey(afterAccessionId);
              joinReq.input("afterAccessionKey", pk.type, pk.val);
            }
            const sqlCh = useStartSqlAcc ? chunkSqlOptFirst : chunkSqlOptKeyset;
            const tJoin = Date.now();
            const joinRes = await joinReq.query(sqlCh);
            fetchMs = Date.now() - tJoin;
            rows = joinRes.recordset || [];
            probeMs = 0;
            detailMs = fetchMs;
            if (debugLogs && !singleLineUi) {
              writeOutLine(
                `>>> [${KEY}] fetch chunk ${nextProbeLabel} TOP+JOIN: rows=${rows.length}, ms=${fetchMs}${useStartSqlAcc ? " (เธเธฒเธเธ•เนเธ)" : ""}`,
                uiState,
              );
            }
          } else {
            const probeReq = pool.request().input("page", sql.Int, pageSize);
            bindMigrateSrcNumericRange(probeReq, migration, sql);
            if (!useStartSqlAcc) {
              const pk = mssqlParamForAccessionKey(afterAccessionId);
              probeReq.input("afterAccessionKey", pk.type, pk.val);
            }

            const probeStartedAt = Date.now();
            const idRes = await probeReq.query(
              useStartSqlAcc ? probeSqlFirst : probeSqlKeyset,
            );
            probeMs = Date.now() - probeStartedAt;
            const idRows = idRes.recordset || [];
            accRawKeys = idRows
              .map((r) => readIdRowAccessionKey(r))
              .filter((v) => v != null && String(v).trim() !== "");

            if (debugLogs && !singleLineUi) {
              writeOutLine(
                `>>> [${KEY}] probe chunk ${nextProbeLabel} done: keys=${accRawKeys.length}, ms=${probeMs}`,
                uiState,
              );
            }

            if (accRawKeys.length === 0) {
              if (idRows.length > 0) {
                console.error(
                  `>>> [${KEY}] เธเธณเน€เธ•เธทเธญเธ: id query เนเธ”เน ${idRows.length} เนเธ–เธง เนเธ•เนเนเธกเนเธกเธตเธเธตเธขเนเธเธฒเธ __acc_key (${Object.keys(idRows[0] ?? {}).join(", ")})`,
                );
              }
              break;
            }

            const sliceCount = Math.max(
              1,
              Math.ceil(accRawKeys.length / mssqlDetailInChunkSize),
            );
            rows = [];
            const tpl =
              detailSqlTemplate ??
              buildMssqlPacsSyncInfoDetailSql(
                studyDescriptionMaxChars,
              ).replaceAll("{{sourceObject}}", sourceObjectNoLock);
            for (let s = 0; s < sliceCount; s++) {
              const lo = s * mssqlDetailInChunkSize;
              const slice = accRawKeys.slice(lo, lo + mssqlDetailInChunkSize);
              if (slice.length === 0) break;

              const idPlaceholders = slice.map((_, i) => `@id${i}`).join(", ");
              const detailSql = tpl.replaceAll(
                "{{idPlaceholders}}",
                idPlaceholders,
              );
              const detailReq = pool.request();
              slice.forEach((key, i) => {
                const pk = mssqlParamForAccessionKey(key);
                detailReq.input(`id${i}`, pk.type, pk.val);
              });

              const sliceStartedAt = Date.now();
              const detailRes = await detailReq.query(detailSql);
              const sliceMs = Date.now() - sliceStartedAt;
              detailMs += sliceMs;
              rows.push(...(detailRes.recordset || []));
              if (debugLogs && !singleLineUi) {
                writeOutLine(
                  `>>> [${KEY}] MSSQL detail ${nextProbeLabel} slice ${s + 1}/${sliceCount}: rows=${detailRes.recordset?.length ?? 0}, ms=${sliceMs}`,
                  uiState,
                );
              }
            }

            fetchMs = probeMs + detailMs;

            if (debugLogs && !singleLineUi) {
              writeOutLine(
                `>>> [${KEY}] fetch chunk ${nextProbeLabel} done: rows=${rows.length}, ms=${fetchMs} (probe=${probeMs}, detail=${detailMs}; ${sliceCount} IN-query, โค${mssqlDetailInChunkSize} params)`,
                uiState,
              );
            }
          }

          if (rows.length === 0) break;

          chunkIndex += 1;
          const { first: firstAccessionId, last: lastAccessionId } =
            firstLastRowField(rows, "accession_id", (v) => {
              if (v == null) return null;
              const s = String(v).trim();
              return s === "" ? null : s;
            });
          const normalized = rows.map((r, i) =>
            normalizePacsSyncMssqlRow(r, offset + i),
          );
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

            step = "post-load (pacs_sync_info)";
            const postLoadStartedAt = Date.now();
            await runPacsSyncInfoChunkPostLoad(client);
            postLoadMs = Date.now() - postLoadStartedAt;
            const issueResult = await runPacsSyncStagingFieldIssuePipeline(
              client,
              rows,
              (r, i) => normalizePacsSyncMssqlRow(r, offset + i),
              "migrate_stg.pacs_sync_info_mssql",
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
              migrationLeg: "acc",
              failedAtStep: step,
              rowCount: rows.length,
              firstAccessionId,
              lastAccessionId,
              fetchMs,
              chunkTotalMs: Date.now() - chunkStartedAt,
              error: err instanceof Error ? err.message : String(err),
            });
            throw new Error(
              `[${KEY}] failed chunk ${chunkIndex} at step '${step}': ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          chunkLog.record({
            chunkIndex,
            status: "success",
            migrationLeg: "acc",
            rowCount: rows.length,
            firstAccessionId,
            lastAccessionId,
            fetchMs,
            stagingMs,
            postLoadMs,
            chunkTotalMs: Date.now() - chunkStartedAt,
          });

          rowsProcessed += rows.length;
          offset = rowsProcessed;
          /** @type {unknown} */
          let ckKey = null;
          if (useOffsetPagination) {
            afterAccessionId = null;
          } else if (useCompositeAcc) {
            accLegCursor = readAccLegCompositeFromRow(rows[rows.length - 1]);
            ckKey = readCheckpointAccessionRow(rows[rows.length - 1]);
            afterAccessionId =
              ckKey != null ? accessionKeyForCheckpoint(ckKey) : null;
          } else if (mssqlOptimizeSingleQuery) {
            ckKey = readCheckpointAccessionRow(rows[rows.length - 1]);
            if (ckKey == null || String(ckKey).trim() === "") {
              throw new Error(
                `[${KEY}] TOP+JOIN chunk ${nextProbeLabel}: เนเธ–เธงเธชเธธเธ”เธ—เนเธฒเธขเธเธฒเธ” __checkpoint_acc_key`,
              );
            }
          } else if (accRawKeys.length > 0) {
            ckKey = accRawKeys[accRawKeys.length - 1];
          }
          if (!useOffsetPagination && !useCompositeAcc && ckKey != null) {
            afterAccessionId = accessionKeyForCheckpoint(ckKey);
          }

          if (checkpointEnabled) {
            writeJson(checkpointPath, {
              key: KEY,
              offset,
              afterAccessionId,
              mssqlPagination,
              migrationLeg: "acc",
              nullTailCursor: null,
              accLegCursor:
                useCompositeAcc && accLegCursor
                  ? serializeAccLegCursor(accLegCursor)
                  : null,
              accFingerprintVersion: useCompositeAcc
                ? PACSSYNC_ROW_FINGERPRINT_VERSION
                : null,
              nullTailDone: false,
              completed: false,
              updatedAt: new Date().toISOString(),
            });
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
              progressTotal != null
                ? Math.min(rowsProcessed, progressTotal)
                : rowsProcessed,
              progressTotal,
              startedAt,
              chunkIndex,
              plannedChunks,
              uiState,
            );
          }

          if (
            isIndexWindowComplete({
              indexLimited: idx.indexLimited,
              plannedRows,
              rowsReadInWindow: Math.max(0, offset - idx.indexStartOffset),
            }) ||
            rows.length < pageSize
          ) {
            break;
          }
        }
      }

      const indexWindowFull =
        idx.indexLimited &&
        isIndexWindowComplete({
          indexLimited: idx.indexLimited,
          plannedRows,
          rowsReadInWindow: Math.max(0, offset - idx.indexStartOffset),
        });
      if (
        useKeysetPlusNull &&
        mssqlOptimizeSingleQuery &&
        nullAccSqlFirst &&
        nullAccSqlKeyset &&
        !indexWindowFull
      ) {
        if (!onlyNullTail) {
          console.error(
            `>>> [${KEY}] เฟส 2: แถวที่ [Accession_ID] IS NULL (keyset เรียง)`,
          );
        }
        const sourceCounts = await queryPacsSyncSourceRowCounts(
          pool,
          sourceObjectNoLock,
        );
        let accBaseline = rowsProcessed;
        let nullRowsDone = 0;
        if (
          sourceCounts.accOnly != null &&
          Number.isFinite(sourceCounts.accOnly) &&
          sourceCounts.accOnly >= 0
        ) {
          accBaseline = sourceCounts.accOnly;
          if (rowsProcessed !== accBaseline) {
            console.error(
              `>>> [${KEY}] เฟส null-tail: ปรับ baseline acc ${rowsProcessed} -> ${accBaseline} (ไม่นับซ้ำกับเฟส acc)`,
            );
            rowsProcessed = accBaseline;
            offset = accBaseline;
          }
        }
        if (
          sourceCounts.total != null &&
          Number.isFinite(sourceCounts.total) &&
          sourceCounts.total > 0
        ) {
          plannedRows = sourceCounts.total;
          progressTotal = sourceCounts.total;
          runLog.plannedRows = plannedRows;
        }
        let nullCk = nullTailCursor;
        while (true) {
          const chunkStartedAt = Date.now();
          const rowsInNullWindow = Math.max(0, offset - idx.indexStartOffset);
          const nullPageSize = resolvePageSize({
            batchSize,
            total: rowsInNullWindow,
            plannedRows: idx.indexLimited ? plannedRows : null,
          });
          if (nullPageSize <= 0) break;
          const nextProbeLabel = chunkIndex + 1;
          let rows = [];
          let fetchMs = 0;
          const nullReq = pool.request().input("page", sql.Int, nullPageSize);
          bindMigrateSrcNumericRange(nullReq, migration, sql);
          if (nullCk == null) {
            const t0 = Date.now();
            const res = await nullReq.query(nullAccSqlFirst);
            fetchMs = Date.now() - t0;
            rows = res.recordset || [];
          } else {
            attachNullTailKeysetParams(nullReq, nullCk);
            const t0 = Date.now();
            const res = await nullReq.query(nullAccSqlKeyset);
            fetchMs = Date.now() - t0;
            rows = res.recordset || [];
          }
          if (debugLogs && !singleLineUi) {
            writeOutLine(
              `>>> [${KEY}] null-tail fetch ${nextProbeLabel}: rows=${rows.length}, ms=${fetchMs}`,
              uiState,
            );
          }
          if (rows.length === 0) break;

          chunkIndex += 1;
          const { first: firstAccessionId, last: lastAccessionId } =
            firstLastRowField(rows, "accession_id", (v) => {
              if (v == null) return null;
              const s = String(v).trim();
              return s === "" ? null : s;
            });
          const normalized = rows.map((r, i) =>
            normalizePacsSyncMssqlRow(r, offset + i),
          );
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

            step = "post-load (pacs_sync_info)";
            const postLoadStartedAt = Date.now();
            await runPacsSyncInfoChunkPostLoad(client);
            postLoadMs = Date.now() - postLoadStartedAt;
            const issueResult = await runPacsSyncStagingFieldIssuePipeline(
              client,
              rows,
              (r, i) => normalizePacsSyncMssqlRow(r, offset + i),
              "migrate_stg.pacs_sync_info_mssql",
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
              migrationLeg: "null_acc",
              failedAtStep: step,
              rowCount: rows.length,
              firstAccessionId,
              lastAccessionId,
              fetchMs,
              chunkTotalMs: Date.now() - chunkStartedAt,
              error: err instanceof Error ? err.message : String(err),
            });
            throw new Error(
              `[${KEY}] null-tail failed chunk ${chunkIndex} at step '${step}': ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          chunkLog.record({
            chunkIndex,
            status: "success",
            migrationLeg: "null_acc",
            rowCount: rows.length,
            firstAccessionId,
            lastAccessionId,
            fetchMs,
            stagingMs,
            postLoadMs,
            chunkTotalMs: Date.now() - chunkStartedAt,
          });

          nullRowsDone += rows.length;
          rowsProcessed = accBaseline + nullRowsDone;
          offset = rowsProcessed;
          nullCk = readNullTailCheckpointFromRow(rows[rows.length - 1]);

          if (checkpointEnabled) {
            writeJson(checkpointPath, {
              key: KEY,
              offset:
                progressTotal != null
                  ? Math.min(offset, progressTotal)
                  : offset,
              afterAccessionId: null,
              mssqlPagination,
              migrationLeg: "null_acc",
              nullTailCursor: serializeNullTailCursor(nullCk),
              accLegCursor: null,
              accFingerprintVersion: PACSSYNC_ROW_FINGERPRINT_VERSION,
              nullTailDone: false,
              completed: false,
              updatedAt: new Date().toISOString(),
            });
          }

          if (debugLogs && !singleLineUi) {
            writeOutLine(
              `>>> [${KEY}] null-tail chunk ${chunkIndex}/${plannedChunks ?? "?"} done ${formatSec(
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
              progressTotal != null
                ? Math.min(rowsProcessed, progressTotal)
                : rowsProcessed,
              progressTotal,
              startedAt,
              chunkIndex,
              plannedChunks,
              uiState,
            );
          }

          if (
            isIndexWindowComplete({
              indexLimited: idx.indexLimited,
              plannedRows,
              rowsReadInWindow: Math.max(0, offset - idx.indexStartOffset),
            }) ||
            rows.length < nullPageSize ||
            (sourceCounts.nullOnly != null &&
              nullRowsDone >= sourceCounts.nullOnly)
          ) {
            break;
          }
        }
      }

      const finalCounts = await queryPacsSyncSourceRowCounts(
        pool,
        sourceObjectNoLock,
      );
      if (
        finalCounts.total != null &&
        Number.isFinite(finalCounts.total) &&
        finalCounts.total >= 0
      ) {
        rowsProcessed = finalCounts.total;
        offset = finalCounts.total;
        plannedRows = finalCounts.total;
      }

      runLog.rowsProcessed = rowsProcessed;
      if (plannedRows != null) {
        console.error(
          `>>> [${KEY}] migrated: ${rowsProcessed} / ${plannedRows} rows`,
        );
        if (rowsProcessed !== plannedRows) {
          console.error(
            `>>> [${KEY}] หมายเหตุ: แถวที่ประมวลผล (${rowsProcessed}) ไม่เท่า plan COUNT (${plannedRows}), ต่าง ${rowsProcessed - plannedRows}`,
          );
        }
      }

      await syncPacsSyncInfoIdSequence(client);

      if (checkpointEnabled) {
        writeJson(checkpointPath, {
          key: KEY,
          offset,
          afterAccessionId:
            useOffsetPagination || useKeysetPlusNull ? null : afterAccessionId,
          mssqlPagination,
          migrationLeg: "done",
          nullTailCursor: null,
          accLegCursor: null,
          accFingerprintVersion: PACSSYNC_ROW_FINGERPRINT_VERSION,
          nullTailDone: true,
          completed: true,
          updatedAt: new Date().toISOString(),
        });
      }
      if (progressEnabled) endProgress(uiState);

      let fieldIssueLogWritten = null;
      if (fieldIssueAcc.totalFieldIssueCount > 0) {
        const payload = buildFieldIssueLogPayload(fieldIssueAcc, {
          migrationKey: KEY,
          logType: "pacs_sync_info_field_issues",
          recordIdKey: "accession_id",
          buildRecord: (rec) => ({
            accession_id: String(rec.accession_id),
            pid: rec.pid ?? null,
            fieldIssues: rec.fieldIssues ?? [],
          }),
        });
        writeFieldIssueLogFile(fieldIssueLogPath, payload);
        fieldIssueLogWritten = fieldIssueLogPath;
      }
      runLog.fieldIssueLogPath = fieldIssueLogWritten;
      runLog.status = "success";
      runLog.migrationLeg = "done";
      runLog.nullTailDone = true;
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
