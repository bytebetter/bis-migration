import fs from "node:fs";
import path from "node:path";
import sql from "mssql";

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
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
    },
    pool: { max: 5, min: 0 },
  };
}

function parseTable(inputTable) {
  const t = String(inputTable || "").trim();
  if (!t) throw new Error("Missing --table (example: dbo.examination)");
  const parts = t.split(".");
  if (parts.length === 1) return { schema: "dbo", table: parts[0] };
  return { schema: parts[0], table: parts[1] };
}

function bracket(value) {
  return `[${String(value).replace(/]/g, "]]")}]`;
}

function parseBoolArg(name, fallback = false) {
  const v = arg(name, null);
  if (v == null) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(v).toLowerCase());
}

function renderProgress(current, total, startedAtMs) {
  const width = 28;
  const ratio = total <= 0 ? 0 : Math.max(0, Math.min(1, current / total));
  const filled = Math.round(width * ratio);
  const bar = `${"#".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}`;
  const pct = (ratio * 100).toFixed(1).padStart(5, " ");
  const elapsedSec = ((Date.now() - startedAtMs) / 1000).toFixed(1).padStart(6, " ");
  process.stdout.write(`\r[${bar}] ${pct}%  rows ${current}/${total}  elapsed ${elapsedSec}s`);
}

async function main() {
  const configPath = path.resolve(process.cwd(), arg("--config", "./migration.config.local.json"));
  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const config = resolveRuntimeConfig(rawConfig, "examination");

  const tableArg = arg("--table", "");
  const { schema, table } = parseTable(tableArg);
  const all = parseBoolArg("--all", false);
  const limit = all ? null : Math.max(1, Number(arg("--limit", "5000")));
  const defaultPageSize = Math.max(
    100,
    Number(config?.migration?.batchSize ?? 1000),
  );
  const pageSize = Math.max(100, Number(arg("--page-size", String(defaultPageSize))));

  const defaultOut = path.resolve(process.cwd(), `./exports/${schema}.${table}.${Date.now()}.json`);
  const outputPath = path.resolve(process.cwd(), arg("--out", defaultOut));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const mssqlConfig = buildMssqlConfig(config.source);
  const countQuery = `SELECT COUNT_BIG(1) AS total FROM ${bracket(schema)}.${bracket(table)} WITH (NOLOCK);`;
  const pageQuery = `
SELECT *
FROM ${bracket(schema)}.${bracket(table)} WITH (NOLOCK)
ORDER BY (SELECT NULL)
OFFSET @offset ROWS FETCH NEXT @page ROWS ONLY;
`;

  const pool = await sql.connect(mssqlConfig);
  try {
    const started = Date.now();
    const countRes = await pool.request().query(countQuery);
    const totalInTable = Number(countRes.recordset?.[0]?.total ?? 0);
    const totalTarget = all ? totalInTable : Math.min(totalInTable, Number(limit));
    const ws = fs.createWriteStream(outputPath, { encoding: "utf8" });
    const header = {
      exportedAt: new Date().toISOString(),
      source: {
        server: mssqlConfig.server,
        database: mssqlConfig.database,
        table: `${schema}.${table}`,
      },
      all,
      limit,
      pageSize,
      totalInTable,
      rowCount: 0,
      elapsedMs: 0,
    };
    ws.write('{\n');
    ws.write(`  "exportedAt": ${JSON.stringify(header.exportedAt)},\n`);
    ws.write('  "source": {\n');
    ws.write(`    "server": ${JSON.stringify(header.source.server)},\n`);
    ws.write(`    "database": ${JSON.stringify(header.source.database)},\n`);
    ws.write(`    "table": ${JSON.stringify(header.source.table)}\n`);
    ws.write("  },\n");
    ws.write(`  "all": ${JSON.stringify(all)},\n`);
    ws.write(`  "limit": ${JSON.stringify(limit)},\n`);
    ws.write(`  "pageSize": ${JSON.stringify(pageSize)},\n`);
    ws.write(`  "totalInTable": ${JSON.stringify(totalInTable)},\n`);
    ws.write('  "rows": [\n');

    let offset = 0;
    let wroteAnyRow = false;
    if (totalTarget > 0) {
      renderProgress(0, totalTarget, started);
    }
    while (offset < totalTarget) {
      const page = Math.min(pageSize, totalTarget - offset);
      const res = await pool
        .request()
        .input("offset", sql.Int, offset)
        .input("page", sql.Int, page)
        .query(pageQuery);
      const chunk = res.recordset || [];
      for (const row of chunk) {
        const rowJson = JSON.stringify(row);
        if (wroteAnyRow) ws.write(",\n");
        ws.write(`    ${rowJson}`);
        wroteAnyRow = true;
      }
      offset += chunk.length;
      renderProgress(offset, totalTarget, started);
      if (chunk.length < page) break;
    }
    if (totalTarget > 0) process.stdout.write("\n");
    const elapsedMs = Date.now() - started;
    ws.write("\n  ],\n");
    ws.write(`  "rowCount": ${offset},\n`);
    ws.write(`  "elapsedMs": ${elapsedMs}\n`);
    ws.write("}\n");
    await new Promise((resolve, reject) => {
      ws.end((err) => (err ? reject(err) : resolve()));
    });

    console.error(`Exported ${offset} rows -> ${outputPath}`);
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

