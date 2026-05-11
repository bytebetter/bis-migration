import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sql from "mssql";
import pg from "pg";

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function parseBoolArg(name, fallback = false) {
  const v = arg(name, null);
  if (v == null) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(v).toLowerCase());
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

function resolveRuntimeConfig(rawConfig, fallbackProfile) {
  if (!rawConfig?.profiles) return rawConfig;
  const selectedProfile = arg("--profile", rawConfig.defaultProfile ?? fallbackProfile);
  const profileConfig = rawConfig.profiles[selectedProfile];
  if (!profileConfig) throw new Error(`Profile '${selectedProfile}' not found in config.profiles`);
  const shared = rawConfig.shared ?? {};
  return {
    ...shared,
    ...profileConfig,
    source: { ...(shared.source ?? {}), ...(profileConfig.source ?? {}) },
    target: { ...(shared.target ?? {}), ...(profileConfig.target ?? {}) },
    migration: { ...(shared.migration ?? {}), ...(profileConfig.migration ?? {}) },
    __profileName: selectedProfile,
  };
}

function buildMssqlConfig(sourceConfig = {}) {
  if (sourceConfig.mssqlUrl) return parseMssqlUrl(sourceConfig.mssqlUrl);
  return {
    server: sourceConfig.server,
    port: Number(sourceConfig.port ?? 1433),
    database: sourceConfig.database,
    user: sourceConfig.user,
    password: sourceConfig.password,
    options: {
      encrypt: sourceConfig.encrypt !== false,
      trustServerCertificate: sourceConfig.trustServerCertificate !== false,
      requestTimeout:
        sourceConfig.requestTimeout == null ? 0 : Number(sourceConfig.requestTimeout),
      connectTimeout:
        sourceConfig.connectTimeout == null ? 60000 : Number(sourceConfig.connectTimeout),
      cancelTimeout:
        sourceConfig.cancelTimeout == null ? 0 : Number(sourceConfig.cancelTimeout),
    },
    pool: { max: 5, min: 0 },
  };
}

function buildPgConfig(targetConfig = {}) {
  return {
    host: targetConfig.postgresHost,
    port: Number(targetConfig.postgresPort ?? 5432),
    user: targetConfig.postgresUser,
    password: targetConfig.postgresPassword,
    database: targetConfig.postgresDatabase,
  };
}

function parseTable(inputTable) {
  const t = String(inputTable || "").trim();
  if (!t) throw new Error("Missing --table (example: dbo.patient_info)");
  const parts = t.split(".");
  if (parts.length === 1) return { schema: "dbo", table: parts[0] };
  return { schema: parts[0], table: parts[1] };
}

function mssqlIdent(value) {
  return `[${String(value).replace(/]/g, "]]")}]`;
}

function pgIdent(value) {
  return `"${String(value).replace(/"/g, "\"\"")}"`;
}

function normalizeRow(row) {
  const obj = {};
  for (const key of Object.keys(row).sort((a, b) => a.localeCompare(b))) {
    const lowered = key.toLowerCase();
    const value = row[key];
    if (value instanceof Date) {
      obj[lowered] = value.toISOString();
    } else if (Buffer.isBuffer(value)) {
      obj[lowered] = value.toString("hex");
    } else {
      obj[lowered] = value;
    }
  }
  return obj;
}

function rowHash(row) {
  const normalized = normalizeRow(row);
  const json = JSON.stringify(normalized);
  return crypto.createHash("sha256").update(json).digest("hex");
}

function hashHistogram(rows) {
  const map = new Map();
  for (const row of rows) {
    const h = rowHash(row);
    map.set(h, (map.get(h) ?? 0) + 1);
  }
  return map;
}

function overlapCount(left, right) {
  let overlap = 0;
  for (const [k, leftCount] of left.entries()) {
    const rightCount = right.get(k) ?? 0;
    overlap += Math.min(leftCount, rightCount);
  }
  return overlap;
}

function normalizeValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("hex");
  return value;
}

function lowerKeyRecord(row) {
  const obj = {};
  for (const key of Object.keys(row ?? {})) {
    obj[String(key).toLowerCase()] = row[key];
  }
  return obj;
}

function compareRowsByKey({
  mssqlRows,
  pgRows,
  mssqlKeyColumn,
  pgKeyColumn,
  sharedColumns,
  maxDiffRows,
}) {
  const mssqlKeyLower = String(mssqlKeyColumn).toLowerCase();
  const pgKeyLower = String(pgKeyColumn).toLowerCase();
  const pgMap = new Map();
  for (const row of pgRows) {
    const normalized = lowerKeyRecord(row);
    const k = normalized[pgKeyLower];
    if (k == null) continue;
    if (!pgMap.has(String(k))) pgMap.set(String(k), []);
    pgMap.get(String(k)).push(normalized);
  }

  const details = [];
  let missingInPostgres = 0;
  let fieldMismatchRows = 0;
  let exactMatchRows = 0;

  for (const mssqlRaw of mssqlRows) {
    const mssql = lowerKeyRecord(mssqlRaw);
    const keyValue = mssql[mssqlKeyLower];
    if (keyValue == null) continue;
    const candidates = pgMap.get(String(keyValue)) ?? [];
    if (candidates.length === 0) {
      missingInPostgres += 1;
      if (details.length < maxDiffRows) {
        details.push({
          key: keyValue,
          status: "missing_in_postgres",
          fieldDiffs: [],
        });
      }
      continue;
    }

    const pgMatch = candidates.shift();
    let rowHasMismatch = false;
    const fieldDiffs = [];
    for (const col of sharedColumns) {
      const a = normalizeValue(mssql[col]);
      const b = normalizeValue(pgMatch[col]);
      if (a !== b) {
        rowHasMismatch = true;
        fieldDiffs.push({ field: col, mssql: a, postgres: b });
      }
    }
    if (rowHasMismatch) {
      fieldMismatchRows += 1;
      if (details.length < maxDiffRows) {
        details.push({
          key: keyValue,
          status: "field_mismatch",
          fieldDiffs,
        });
      }
    } else {
      exactMatchRows += 1;
    }
  }

  let missingInMssql = 0;
  for (const [k, remain] of pgMap.entries()) {
    for (let i = 0; i < remain.length; i++) {
      missingInMssql += 1;
      if (details.length < maxDiffRows) {
        details.push({
          key: k,
          status: "missing_in_mssql",
          fieldDiffs: [],
        });
      }
    }
  }

  return {
    mssqlKeyColumn: mssqlKeyLower,
    postgresKeyColumn: pgKeyLower,
    comparedKeys: exactMatchRows + fieldMismatchRows,
    exactMatchRows,
    fieldMismatchRows,
    missingInPostgres,
    missingInMssql,
    mismatchRowsTotal: fieldMismatchRows + missingInPostgres + missingInMssql,
    detailLimit: maxDiffRows,
    rowDiffs: details,
  };
}

async function readMssqlColumns(pool, schema, table) {
  const q = `
SELECT COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
ORDER BY ORDINAL_POSITION;
`;
  const res = await pool
    .request()
    .input("schema", sql.NVarChar, schema)
    .input("table", sql.NVarChar, table)
    .query(q);
  return (res.recordset ?? []).map((r) => String(r.COLUMN_NAME).toLowerCase());
}

async function readPgColumns(client, schema, table) {
  const q = `
SELECT column_name
FROM information_schema.columns
WHERE table_schema = $1 AND table_name = $2
ORDER BY ordinal_position;
`;
  const res = await client.query(q, [schema, table]);
  return (res.rows ?? []).map((r) => String(r.column_name).toLowerCase());
}

function toSafeOrderByMssql(raw) {
  if (!raw) return null;
  return String(raw)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((name) => mssqlIdent(name))
    .join(", ");
}

function toSafeOrderByPg(raw) {
  if (!raw) return null;
  return String(raw)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((name) => pgIdent(name))
    .join(", ");
}

function isIntegerLike(value) {
  return /^-?\d+$/.test(String(value ?? "").trim());
}

function buildRangeWhereMssql({ keyColumn, keyStart, keyEnd }) {
  if (keyStart == null || keyEnd == null || !keyColumn) return { sql: "", params: [] };
  const keyExpr = mssqlIdent(keyColumn);
  const numericMode = isIntegerLike(keyStart) && isIntegerLike(keyEnd);
  if (numericMode) {
    return {
      sql: `WHERE TRY_CONVERT(BIGINT, ${keyExpr}) BETWEEN @keyStartNum AND @keyEndNum`,
      params: [
        { name: "keyStartNum", type: sql.BigInt, value: BigInt(String(keyStart)) },
        { name: "keyEndNum", type: sql.BigInt, value: BigInt(String(keyEnd)) },
      ],
    };
  }
  return {
    sql: `WHERE ${keyExpr} >= @keyStart AND ${keyExpr} <= @keyEnd`,
    params: [
      { name: "keyStart", type: sql.NVarChar, value: String(keyStart) },
      { name: "keyEnd", type: sql.NVarChar, value: String(keyEnd) },
    ],
  };
}

function buildRangeWherePg({ keyColumn, keyStart, keyEnd, firstParamIndex = 1 }) {
  if (keyStart == null || keyEnd == null || !keyColumn) return { sql: "", params: [] };
  const keyExpr = pgIdent(keyColumn);
  const pStart = `$${firstParamIndex}`;
  const pEnd = `$${firstParamIndex + 1}`;
  const numericMode = isIntegerLike(keyStart) && isIntegerLike(keyEnd);
  if (numericMode) {
    return {
      sql: `WHERE (${keyExpr})::text ~ '^-?\\d+$' AND (${keyExpr})::bigint BETWEEN ${pStart}::bigint AND ${pEnd}::bigint`,
      params: [String(keyStart), String(keyEnd)],
    };
  }
  return {
    sql: `WHERE (${keyExpr})::text >= ${pStart}::text AND (${keyExpr})::text <= ${pEnd}::text`,
    params: [String(keyStart), String(keyEnd)],
  };
}

async function tableExistsInPg(client, schema, table) {
  const q = `
SELECT 1
FROM information_schema.tables
WHERE table_schema = $1 AND table_name = $2
LIMIT 1;
`;
  const res = await client.query(q, [schema, table]);
  return (res.rows ?? []).length > 0;
}

async function resolvePgTableLocation(client, requestedSchema, table) {
  if (await tableExistsInPg(client, requestedSchema, table)) {
    return { schema: requestedSchema, table, autoResolved: false, candidates: [] };
  }
  const q = `
SELECT table_schema
FROM information_schema.tables
WHERE table_name = $1
ORDER BY CASE WHEN table_schema = 'public' THEN 0 ELSE 1 END, table_schema;
`;
  const res = await client.query(q, [table]);
  const schemas = (res.rows ?? []).map((r) => String(r.table_schema));
  if (schemas.length === 0) {
    throw new Error(
      `Postgres table not found: ${requestedSchema}.${table} (and no table named '${table}' in any schema)`,
    );
  }
  return {
    schema: schemas[0],
    table,
    autoResolved: true,
    candidates: schemas,
  };
}

async function main() {
  const configPath = path.resolve(process.cwd(), arg("--config", "./migration.config.local.json"));
  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const config = resolveRuntimeConfig(rawConfig, "patient_info");
  const { schema, table } = parseTable(arg("--table", ""));
  const limit = Math.max(
    1,
    Number(arg("--length", arg("--limit", String(config?.migration?.batchSize ?? 1000)))),
  );
  const includeSample = parseBoolArg("--include-sample", true);
  const orderByArg = arg("--order-by", "");
  const keyColumnArg = arg("--key-column", "");
  const mssqlKeyColumnArg = arg("--mssql-key-column", "");
  const pgKeyColumnArg = arg("--pg-key-column", "");
  const maxDiffRows = Math.max(1, Number(arg("--max-diff-rows", "200")));
  const keyStartArg = arg("--key-start", null);
  const keyEndArg = arg("--key-end", null);

  const mssqlOrderBy = toSafeOrderByMssql(orderByArg);
  const pgOrderBy = toSafeOrderByPg(orderByArg);
  const fallbackKeyFromOrderBy = orderByArg
    ? String(orderByArg)
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)[0] ?? ""
    : "";
  const commonKeyColumn = (keyColumnArg || fallbackKeyFromOrderBy || "id").toLowerCase();
  const mssqlKeyColumn = (mssqlKeyColumnArg || commonKeyColumn).toLowerCase();
  const pgKeyColumn = (pgKeyColumnArg || commonKeyColumn).toLowerCase();
  const hasKeyRange = keyStartArg != null && keyEndArg != null;

  const reportDir = path.resolve(process.cwd(), "./compare-reports");
  fs.mkdirSync(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportDir, `${schema}.${table}.${stamp}.json`);

  const mssqlConfig = buildMssqlConfig(config.source);
  const pgConfig = buildPgConfig(config.target);
  const mssqlPool = await sql.connect(mssqlConfig);
  const pgClient = new pg.Client(pgConfig);
  await pgClient.connect();

  try {
    const started = Date.now();
    const pgResolved = await resolvePgTableLocation(pgClient, schema, table);
    const pgSchema = pgResolved.schema;
    const mssqlRange = buildRangeWhereMssql({
      keyColumn: mssqlKeyColumn,
      keyStart: keyStartArg,
      keyEnd: keyEndArg,
    });
    const pgRange = buildRangeWherePg({
      keyColumn: pgKeyColumn,
      keyStart: keyStartArg,
      keyEnd: keyEndArg,
      firstParamIndex: 1,
    });
    const mssqlCountQ = `SELECT COUNT_BIG(1) AS total FROM ${mssqlIdent(schema)}.${mssqlIdent(table)} WITH (NOLOCK) ${mssqlRange.sql};`;
    const pgCountQ = `SELECT COUNT(*)::bigint AS total FROM ${pgIdent(pgSchema)}.${pgIdent(table)} ${pgRange.sql};`;
    const mssqlCountReq = mssqlPool.request();
    for (const p of mssqlRange.params) mssqlCountReq.input(p.name, p.type, p.value);
    const pgCountParams = pgRange.params;
    const [mssqlCountRes, pgCountRes] = await Promise.all([
      mssqlCountReq.query(mssqlCountQ),
      pgClient.query(pgCountQ, pgCountParams),
    ]);

    const mssqlTotal = Number(mssqlCountRes.recordset?.[0]?.total ?? 0);
    const pgTotal = Number(pgCountRes.rows?.[0]?.total ?? 0);

    const [mssqlCols, pgCols] = await Promise.all([
      readMssqlColumns(mssqlPool, schema, table),
      readPgColumns(pgClient, pgSchema, table),
    ]);

    const mssqlOnlyColumns = mssqlCols.filter((c) => !pgCols.includes(c));
    const pgOnlyColumns = pgCols.filter((c) => !mssqlCols.includes(c));
    const sharedColumns = mssqlCols.filter((c) => pgCols.includes(c));

    let mssqlSample = [];
    let pgSample = [];
    if (includeSample) {
      const orderMssql = mssqlOrderBy ? `ORDER BY ${mssqlOrderBy}` : "ORDER BY (SELECT NULL)";
      const orderPg = pgOrderBy ? `ORDER BY ${pgOrderBy}` : "";
      const mssqlSampleQ = `
SELECT TOP (@limit) *
FROM ${mssqlIdent(schema)}.${mssqlIdent(table)} WITH (NOLOCK)
${mssqlRange.sql}
${orderMssql};
`;
      const pgRangeForSample = buildRangeWherePg({
        keyColumn: pgKeyColumn,
        keyStart: keyStartArg,
        keyEnd: keyEndArg,
        firstParamIndex: 2,
      });
      const pgSampleQFixed = `
SELECT *
FROM ${pgIdent(pgSchema)}.${pgIdent(table)}
${pgRangeForSample.sql}
${orderPg}
LIMIT $1;
`;
      const mssqlSampleReq = mssqlPool.request().input("limit", sql.Int, limit);
      for (const p of mssqlRange.params) mssqlSampleReq.input(p.name, p.type, p.value);
      const pgSampleParams = [limit, ...pgRangeForSample.params];
      const [mssqlSampleRes, pgSampleRes] = await Promise.all([
        mssqlSampleReq.query(mssqlSampleQ),
        pgClient.query(pgSampleQFixed, pgSampleParams),
      ]);
      mssqlSample = mssqlSampleRes.recordset ?? [];
      pgSample = pgSampleRes.rows ?? [];
    }

    const mssqlHist = hashHistogram(mssqlSample);
    const pgHist = hashHistogram(pgSample);
    const sampleOverlap = overlapCount(mssqlHist, pgHist);
    const keyCompare = includeSample
      ? compareRowsByKey({
          mssqlRows: mssqlSample,
          pgRows: pgSample,
          mssqlKeyColumn,
          pgKeyColumn,
          sharedColumns,
          maxDiffRows,
        })
      : null;

    const report = {
      comparedAt: new Date().toISOString(),
      profile: config.__profileName ?? null,
      table: `${schema}.${table}`,
      resolvedTable: {
        mssql: `${schema}.${table}`,
        postgres: `${pgSchema}.${table}`,
      },
      source: {
        mssql: {
          server: mssqlConfig.server,
          database: mssqlConfig.database,
          totalRows: mssqlTotal,
          columns: mssqlCols,
        },
        postgres: {
          host: pgConfig.host,
          database: pgConfig.database,
          totalRows: pgTotal,
          columns: pgCols,
        },
      },
      options: {
        length: limit,
        includeSample,
        orderBy: orderByArg || null,
        keyColumn: commonKeyColumn,
        mssqlKeyColumn,
        pgKeyColumn,
        maxDiffRows,
        keyRange: hasKeyRange
          ? {
              start: keyStartArg,
              end: keyEndArg,
            }
          : null,
      },
      comparison: {
        rowCountDiff: mssqlTotal - pgTotal,
        sameRowCount: mssqlTotal === pgTotal,
        columnCountDiff: mssqlCols.length - pgCols.length,
        columnsOnlyInMssql: mssqlOnlyColumns,
        columnsOnlyInPostgres: pgOnlyColumns,
        sampleCompared: includeSample ? Math.min(mssqlSample.length, pgSample.length) : 0,
        sampleOverlap,
        keyMatchedComparison: keyCompare,
      },
      elapsedMs: Date.now() - started,
    };

    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    console.log(`Compared table: ${schema}.${table}`);
    if (pgResolved.autoResolved) {
      console.log(
        `Postgres target resolved: requested ${schema}.${table} -> using ${pgSchema}.${table}`,
      );
      if (pgResolved.candidates.length > 1) {
        console.log(`Found in schemas: ${pgResolved.candidates.join(", ")}`);
      }
    }
    console.log(`MSSQL total: ${mssqlTotal}`);
    console.log(`Postgres total: ${pgTotal}`);
    console.log(`Row count diff (MSSQL - Postgres): ${mssqlTotal - pgTotal}`);
    if (includeSample) {
      console.log(
        `Sample overlap: ${sampleOverlap}/${Math.min(mssqlSample.length, pgSample.length)} (length=${limit})`,
      );
      console.log(
        `Key compare (mssql.${mssqlKeyColumn} = postgres.${pgKeyColumn}): mismatched=${keyCompare?.mismatchRowsTotal ?? 0}, exact=${keyCompare?.exactMatchRows ?? 0}`,
      );
    }
    if (hasKeyRange) {
      console.log(
        `Key range filter: mssql.${mssqlKeyColumn} / postgres.${pgKeyColumn} between ${keyStartArg} and ${keyEndArg}`,
      );
    }
    console.log(`Report: ${reportPath}`);
  } finally {
    await Promise.allSettled([mssqlPool.close(), pgClient.end()]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
