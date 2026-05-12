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
  createUiState,
  endProgress,
  formatSec,
  markProgressInline,
  renderProgress,
  writeOutLine,
} from "../../shared/js-migrate/progressUi.mjs";

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
      "MSSQL: กำหนด source.password ใน migration.config.local.json ให้เป็นรหัสจริง",
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
 * bind เป็น NVarChar เสมอสำหรับคีย์เซ็ต —
 * ถ้าส่ง BigInt เมื่อคอลัมน์เป็น varchar/nvarchar แล้วใช้กับ `Accession_ID > @p`
 * SQL Server จะเทียบแบบตัวเลขหลัง implicit cast ไม่ตรงกับ ORDER BY แบบจัดเรียงสตริง
 * (เช่น "594341000" ลำดับสตริงใหญ่กว่า "5943407001" แต่ค่าตัวเลขกลับน้อยกว่า → แถวหาย ~1M)
 */
function mssqlParamForAccessionKey(value) {
  if (value == null) {
    return { type: sql.NVarChar(sql.MAX), val: "" };
  }
  const s =
    typeof value === "bigint"
      ? value.toString()
      : String(value).replace(/^\uFEFF/, "").trimEnd();
  return { type: sql.NVarChar(sql.MAX), val: s };
}

function accessionKeyForCheckpoint(v) {
  if (v == null) return null;
  if (typeof v === "bigint") return v.toString();
  return String(v);
}

/** จากโหมด TOP+JOIN — ใช้ [Accession_ID] ดิบสำหรับ checkpoint */
function readCheckpointAccessionRow(row) {
  if (!row || typeof row !== "object") return undefined;
  if (Object.hasOwn(row, "__checkpoint_acc_key"))
    return row.__checkpoint_acc_key;
  const hit = Object.keys(row).find(
    (k) => k.toLowerCase() === "__checkpoint_acc_key",
  );
  return hit ? row[hit] : undefined;
}

/** แถวจาก id probe — MSSQL ส่งเป็น __acc_key */
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

/** ค่าสำหรับ keyset เฟส Accession_ID IS NULL */
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
      "null-tail: แถวสุดท้ายขาด __null_ck_fp (Buffer) สำหรับ checkpoint",
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

/** keyset composite เฟสมี Accession_ID (แถวสุดท้ายของ chunk) */
function readAccLegCompositeFromRow(row) {
  const accRaw = readCheckpointAccessionRow(row);
  if (accRaw == null || String(accRaw).trim() === "") {
    throw new Error(
      "acc-leg composite: แถวสุดท้ายขาด __checkpoint_acc_key สำหรับ checkpoint",
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
      "acc-leg composite: แถวสุดท้ายขาด __acc_ck_chk (BINARY_CHECKSUM) สำหรับ checkpoint",
    );
  }
  if (!Buffer.isBuffer(fpRaw) || fpRaw.length === 0) {
    throw new Error(
      "acc-leg composite: แถวสุดท้ายขาด __acc_ck_fp (Buffer) สำหรับ checkpoint",
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
    Math.min(5000, Number(config?.migration?.batchSize ?? 2000)),
  );
  const studyDescriptionRaw = config?.migration?.studyDescriptionMaxChars;
  const studyDescriptionMaxChars =
    studyDescriptionRaw === undefined || studyDescriptionRaw === null
      ? 8192
      : Number(studyDescriptionRaw);
  const mssqlOptimizeSingleQuery =
    config?.migration?.mssqlOptimizeSingleQuery !== false;

  /**
   * "keyset_plus_null" (default) = เฟสมี Accession_ID + เฟส NULL — เร็วกว่า offset
   * "offset" = ดึงทั้งตารางด้วย ORDER BY + OFFSET/FETCH (ช้าเมื่อ offset สูง แต่ลำดับชัด/callback ได้ครบแถว)
   * "keyset" = เฉพาะแถวที่มี Accession_ID
   * อ่านเฉพาะสคริปต์ pacs — แนะนำใส่ใน profiles.pacs_sync_info.migration ไม่ใช่ shared
   */
  const mssqlPagination =
    config?.migration?.mssqlPagination ?? "keyset_plus_null";
  const useOffsetPagination = mssqlPagination === "offset";
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
      `>>> [${KEY}] คำเตือน: keyset_plus_null ใช้ได้กับ mssqlOptimizeSingleQuery เท่านั้น — จะไม่รันเฟส null (ใช้ offset หรือเปิด TOP+JOIN)`,
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
  const checkpointPath = path.join(checkpointDir, `${KEY}.json`);
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

  try {
    if (
      checkpointEnabled &&
      checkpoint.completed === true &&
      checkpoint.nullTailDone === true
    ) {
      runLog.status = "skipped";
      runLog.migrationLeg = checkpoint.migrationLeg ?? "done";
      runLog.nullTailDone = true;
      console.error(
        `>>> [${KEY}] checkpoint: ย้ายครบแล้ว (รวมแถว Accession_ID NULL) — ไม่รันซ้ำ`,
      );
      return;
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
      if (debugLogs && !singleLineUi) {
        const sdHint =
          !Number.isFinite(studyDescriptionMaxChars) ||
          studyDescriptionMaxChars <= 0
            ? "StudyDescription เต็ม MAX"
            : `StudyDescription ≤${studyDescriptionMaxChars}`;
        writeOutLine(
          `>>> [${KEY}] options: ${sdHint}; PG indexes จาก DDL; mssqlDetailInChunkSize=${mssqlDetailInChunkSize}`,
          uiState,
        );
      }

      let offset = Number(checkpointEnabled ? checkpoint.offset : 0);
      if (!Number.isFinite(offset) || offset < 0) offset = 0;
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
          afterAccessionId = null;
          migrationLeg = "acc";
          nullTailCursor = null;
          accLegCursor = null;
          console.error(
            `>>> [${KEY}] เปลี่ยน mssqlPagination (${ckMode} -> ${mssqlPagination}) — รีเซ็ตตำแหน่ง checkpoint`,
          );
        } else if (useOffsetPagination && ckMode == null) {
          offset = 0;
          afterAccessionId = null;
          migrationLeg = "acc";
          nullTailCursor = null;
          accLegCursor = null;
          console.error(
            `>>> [${KEY}] โหมด offset: checkpoint เก่าไม่มี mssqlPagination — เริ่มที่ offset 0`,
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
        afterAccessionId = null;
        accLegCursor = null;
        nullTailCursor = null;
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
        afterAccessionId = null;
        accLegCursor = null;
        nullTailCursor = null;
        console.error(
          `>>> [${KEY}] keyset composite: checkpoint ไม่มี accLegCursor — รีเซ็ตเฟส 1 (ดึงซ้ำ Accession ครบ)`,
        );
      }

      const onlyNullTail =
        useKeysetPlusNull &&
        mssqlOptimizeSingleQuery &&
        nullAccSqlFirst != null &&
        checkpointEnabled &&
        (migrationLeg === "null_acc" ||
          (checkpoint.completed === true && checkpoint.nullTailDone !== true));

      if (onlyNullTail) {
        console.error(
          `>>> [${KEY}] รันเฉพาะเฟสแถว Accession_ID NULL (ข้ามเฟสมี Accession_ID)`,
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
      runLog.plannedRows = plannedRows;
      const progressTotal = plannedRows ?? null;
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
          const useStartSqlAcc = useCompositeAcc
            ? accLegCursor == null
            : isCheckpointStart(afterAccessionId);
          const nextProbeLabel = chunkIndex + 1;

          if (debugLogs && !singleLineUi) {
            writeOutLine(
              useCompositeAcc
                ? `>>> [${KEY}] fetch chunk ${nextProbeLabel}: composite acc leg, page=${batchSize}, start=${useStartSqlAcc}`
                : `>>> [${KEY}] fetch chunk ${nextProbeLabel}: afterAccessionId=${afterAccessionId ?? "(start)"}, page=${batchSize}, start=${useStartSqlAcc}`,
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
              .input("page", sql.Int, batchSize)
              .input("offset", sql.Int, offset);
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
            const joinReq = pool.request().input("page", sql.Int, batchSize);
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
                `>>> [${KEY}] fetch chunk ${nextProbeLabel} TOP+JOIN+composite: rows=${rows.length}, ms=${fetchMs}${useStartSqlAcc ? " (จากต้น)" : ""}`,
                uiState,
              );
            }
          } else if (
            mssqlOptimizeSingleQuery &&
            chunkSqlOptFirst &&
            chunkSqlOptKeyset
          ) {
            const joinReq = pool.request().input("page", sql.Int, batchSize);
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
                `>>> [${KEY}] fetch chunk ${nextProbeLabel} TOP+JOIN: rows=${rows.length}, ms=${fetchMs}${useStartSqlAcc ? " (จากต้น)" : ""}`,
                uiState,
              );
            }
          } else {
            const probeReq = pool.request().input("page", sql.Int, batchSize);
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
                  `>>> [${KEY}] คำเตือน: id query ได้ ${idRows.length} แถว แต่ไม่มีคีย์จาก __acc_key (${Object.keys(idRows[0] ?? {}).join(", ")})`,
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
                `>>> [${KEY}] fetch chunk ${nextProbeLabel} done: rows=${rows.length}, ms=${fetchMs} (probe=${probeMs}, detail=${detailMs}; ${sliceCount} IN-query, ≤${mssqlDetailInChunkSize} params)`,
                uiState,
              );
            }
          }

          if (rows.length === 0) break;

          chunkIndex += 1;
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
            runLog.rowsUpserted += loaded;

            step = "COMMIT";
            const commitStartedAt = Date.now();
            await client.query("COMMIT");
            commitMs = Date.now() - commitStartedAt;
          } catch (err) {
            await client.query("ROLLBACK");
            throw new Error(
              `[${KEY}] failed chunk ${chunkIndex} at step '${step}': ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          offset += rows.length;
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
                `[${KEY}] TOP+JOIN chunk ${nextProbeLabel}: แถวสุดท้ายขาด __checkpoint_acc_key`,
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
              offset,
              progressTotal,
              startedAt,
              chunkIndex,
              plannedChunks,
            );
            markProgressInline(uiState);
          }

          if (rows.length < batchSize) break;
        }
      }

      if (
        useKeysetPlusNull &&
        mssqlOptimizeSingleQuery &&
        nullAccSqlFirst &&
        nullAccSqlKeyset
      ) {
        if (!onlyNullTail) {
          console.error(
            `>>> [${KEY}] เฟส 2: แถวที่ [Accession_ID] IS NULL (keyset เร็ว)`,
          );
        }
        let nullCk = nullTailCursor;
        while (true) {
          const chunkStartedAt = Date.now();
          const nextProbeLabel = chunkIndex + 1;
          let rows = [];
          let fetchMs = 0;
          const nullReq = pool.request().input("page", sql.Int, batchSize);
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
            runLog.rowsUpserted += loaded;

            step = "COMMIT";
            const commitStartedAt = Date.now();
            await client.query("COMMIT");
            commitMs = Date.now() - commitStartedAt;
          } catch (err) {
            await client.query("ROLLBACK");
            throw new Error(
              `[${KEY}] null-tail failed chunk ${chunkIndex} at step '${step}': ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          offset += rows.length;
          nullCk = readNullTailCheckpointFromRow(rows[rows.length - 1]);

          if (checkpointEnabled) {
            writeJson(checkpointPath, {
              key: KEY,
              offset,
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
              offset,
              progressTotal,
              startedAt,
              chunkIndex,
              plannedChunks,
            );
            markProgressInline(uiState);
          }

          if (rows.length < batchSize) break;
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
    fs.writeFileSync(logPath, `${JSON.stringify(runLog, null, 2)}\n`, "utf8");
    console.error(`>>> migration log saved: ${logPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
