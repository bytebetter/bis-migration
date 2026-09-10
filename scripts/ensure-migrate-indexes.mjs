/**
 * เช็ค/สร้าง index ฝั่ง MSSQL ที่ migrate pipeline ใช้ — คำสั่งเดียวครบทุกตาราง
 * รันซ้ำได้: index ที่มีอยู่แล้ว (หรือมีตัวที่ครอบให้แล้ว) จะถูกข้าม ไม่สร้างซ้ำ
 *
 * Usage:
 *   node scripts/ensure-migrate-indexes.mjs --check-only       # ดูอย่างเดียว ไม่แก้อะไร (แนะนำรันก่อน)
 *   node scripts/ensure-migrate-indexes.mjs                    # สร้างตัวที่ยังไม่มี
 *   node scripts/ensure-migrate-indexes.mjs --only pacs_export_pdf,biopsy_keyset
 *   node scripts/ensure-migrate-indexes.mjs --include-optional  # รวม spec ที่ mark optional
 *   node scripts/ensure-migrate-indexes.mjs --config ./migration.config.local.json
 *
 * "มีอยู่แล้ว" = มี index ที่ key column ขึ้นต้นตรงกับ spec (prefix match)
 *   spec (Exam_ID)              <- PK (Exam_ID, BiopsyID) ครอบให้แล้ว ไม่ต้องสร้าง
 *   spec (CreatedDate, Exam_ID) <- index (Exam_ID) ครอบไม่ได้ ต้องสร้างใหม่
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import { buildMssqlConfig } from "../shared/js-migrate/mssqlConnectConfig.mjs";
import {
  readConfigPathFromArgv,
  readProfileFromArgv,
  resolveRuntimeConfig,
} from "../shared/js-migrate/resolveMigrationConfig.mjs";
import { MIGRATE_INDEX_SPECS } from "./migrateIndexSpecs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const CREATED_DATE_COLUMN = "CreatedDate";
/** type ที่ใส่ INCLUDE ไม่ได้ */
const INCLUDE_BLOCKED_TYPES = new Set(["text", "ntext", "image"]);
/** EngineEdition ที่สร้าง index แบบ ONLINE ได้ (Enterprise / Azure SQL / Azure MI) */
const ONLINE_CAPABLE_EDITIONS = new Set([3, 5, 8]);

function bracketIdent(value) {
  return `[${String(value).replace(/]/g, "]]")}]`;
}

function readListArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx < 0 || !process.argv[idx + 1]) return null;
  return String(process.argv[idx + 1])
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** ชื่อ index — ตัดไม่เกิน 128 ตัวอักษรตามลิมิต SQL Server */
function indexName(table, keys) {
  return `IX_MIG_${table}_${keys.join("_")}`.slice(0, 128);
}

/** metadata ของตารางเดียว: object_id, คอลัมน์ที่มี, index พร้อม key column เรียงลำดับ */
async function readTableMeta(pool, schema, table) {
  const objectName = `${bracketIdent(schema)}.${bracketIdent(table)}`;
  const res = await pool
    .request()
    .input("object", sql.NVarChar(300), objectName)
    .query("SELECT OBJECT_ID(@object) AS object_id");
  const objectId = res.recordset?.[0]?.object_id ?? null;
  if (objectId == null) return null;

  const colRes = await pool.request().input("oid", sql.Int, objectId).query(`
    SELECT c.name, t.name AS type_name
    FROM sys.columns c
    JOIN sys.types t ON t.user_type_id = c.user_type_id
    WHERE c.object_id = @oid`);
  const columns = new Map(
    (colRes.recordset ?? []).map((r) => [
      String(r.name).toLowerCase(),
      String(r.type_name).toLowerCase(),
    ]),
  );

  // FOR XML PATH แทน STRING_AGG — ใช้ได้ทุก compatibility level
  const idxRes = await pool.request().input("oid", sql.Int, objectId).query(`
    SELECT i.name AS index_name,
           i.type_desc,
           STUFF((
             SELECT ',' + c.name
             FROM sys.index_columns ic
             JOIN sys.columns c
               ON c.object_id = ic.object_id AND c.column_id = ic.column_id
             WHERE ic.object_id = i.object_id
               AND ic.index_id = i.index_id
               AND ic.is_included_column = 0
             ORDER BY ic.key_ordinal
             FOR XML PATH(''), TYPE
           ).value('.', 'NVARCHAR(MAX)'), 1, 1, '') AS key_columns
    FROM sys.indexes i
    WHERE i.object_id = @oid AND i.type IN (1, 2)`);

  return {
    objectId,
    objectName,
    columns,
    indexes: (idxRes.recordset ?? [])
      .filter((r) => r.key_columns)
      .map((r) => ({
        name: r.index_name,
        typeDesc: r.type_desc,
        keyColumns: String(r.key_columns),
      })),
  };
}

/** index ที่ key column ขึ้นต้นตรงกับ keys (ต่อ comma กัน prefix ชนกลางชื่อคอลัมน์) */
function findCoveringIndex(indexes, keys) {
  const want = `${keys.join(",").toLowerCase()},`;
  return indexes.find((i) => `${i.keyColumns.toLowerCase()},`.startsWith(want));
}

export async function ensureMigrateIndexes(
  pool,
  {
    schema = "dbo",
    checkOnly = false,
    includeOptional = false,
    only = null,
    log = console.log,
  },
) {
  const editionRes = await pool
    .request()
    .query("SELECT CAST(SERVERPROPERTY('EngineEdition') AS INT) AS engine_edition");
  const engineEdition = Number(editionRes.recordset?.[0]?.engine_edition ?? 0);
  const onlineClause = ONLINE_CAPABLE_EDITIONS.has(engineEdition)
    ? " WITH (ONLINE = ON)"
    : "";

  const specs = MIGRATE_INDEX_SPECS.filter((s) =>
    only ? only.includes(s.key.toLowerCase()) : includeOptional || !s.optional,
  );

  const metaCache = new Map();
  const results = [];

  for (const spec of specs) {
    const row = {
      key: spec.key,
      table: spec.table,
      keys: spec.keys.join(", "),
      status: "",
      detail: "",
    };
    results.push(row);

    if (!metaCache.has(spec.table)) {
      metaCache.set(spec.table, await readTableMeta(pool, schema, spec.table));
    }
    const meta = metaCache.get(spec.table);
    if (!meta) {
      row.status = "no-table";
      row.detail = "ไม่พบตารางในต้นทาง";
      continue;
    }

    // ไม่มี CreatedDate -> โค้ด migrate fallback ไป keyset แบบเก่า ใช้ legacyKeys แทน
    let keys = spec.keys;
    const wantsCreatedDate = keys.some(
      (k) => k.toLowerCase() === CREATED_DATE_COLUMN.toLowerCase(),
    );
    if (wantsCreatedDate && !meta.columns.has(CREATED_DATE_COLUMN.toLowerCase())) {
      if (!spec.legacyKeys) {
        row.status = "skip";
        row.detail = `ไม่มีคอลัมน์ ${CREATED_DATE_COLUMN}`;
        continue;
      }
      keys = spec.legacyKeys;
      row.keys = `${keys.join(", ")} (legacy: ไม่มี ${CREATED_DATE_COLUMN})`;
    }

    const missingKey = keys.find((k) => !meta.columns.has(k.toLowerCase()));
    if (missingKey) {
      row.status = "skip";
      row.detail = `ไม่มีคอลัมน์ ${missingKey}`;
      continue;
    }

    const covering = findCoveringIndex(meta.indexes, keys);
    if (covering) {
      row.status = "ok";
      row.detail = `มีแล้ว: ${covering.name ?? "(heap)"} (${covering.keyColumns})`;
      continue;
    }

    const includes = (spec.includes ?? []).filter((name) => {
      const type = meta.columns.get(name.toLowerCase());
      return type != null && !INCLUDE_BLOCKED_TYPES.has(type);
    });
    const name = indexName(spec.table, keys);
    const includeClause =
      includes.length > 0
        ? ` INCLUDE (${includes.map(bracketIdent).join(", ")})`
        : "";
    row.ddl =
      `CREATE NONCLUSTERED INDEX ${bracketIdent(name)} ON ${meta.objectName} ` +
      `(${keys.map(bracketIdent).join(", ")})${includeClause}${onlineClause};`;

    if (checkOnly) {
      row.status = "missing";
      row.detail = name;
      continue;
    }

    const startedAt = Date.now();
    try {
      await pool.request().query(row.ddl);
      row.status = "created";
      row.detail = `${name} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`;
    } catch (err) {
      row.status = "failed";
      row.detail = err instanceof Error ? err.message : String(err);
    }
    log(`>>> ${row.status.padEnd(8)} ${row.table} — ${row.detail}`);
  }

  return { engineEdition, onlineClause, results };
}

function printSummary({ results }) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\n${pad("status", 9)}${pad("spec", 24)}${pad("table", 26)}key columns`);
  console.log("-".repeat(100));
  for (const r of results) {
    console.log(`${pad(r.status, 9)}${pad(r.key, 24)}${pad(r.table, 26)}${r.keys}`);
    if (r.detail) console.log(`${" ".repeat(9)}  -> ${r.detail}`);
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  console.log(
    `\nสรุป: ok ${count("ok")} | created ${count("created")} | missing ${count("missing")} | skip ${count("skip")} | no-table ${count("no-table")} | failed ${count("failed")}`,
  );
  const pending = results.filter((r) => r.status === "missing" && r.ddl);
  if (pending.length > 0) {
    console.log("\n-- DDL ของตัวที่ยังไม่มี (copy ไปรันใน SSMS ได้เลย) --");
    for (const r of pending) console.log(r.ddl);
  }
}

async function main() {
  const checkOnly = process.argv.includes("--check-only");
  const includeOptional = process.argv.includes("--include-optional");
  const only = readListArg("--only");

  const configArg = readConfigPathFromArgv();
  const configPath = path.isAbsolute(configArg)
    ? configArg
    : path.resolve(repoRoot, configArg);
  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const profile =
    readProfileFromArgv() ?? rawConfig.defaultProfile ?? "patient_info";
  const config = resolveRuntimeConfig(rawConfig, profile);
  const source = config?.source;
  if (!source) {
    console.error(`missing source config for profile ${profile}`);
    process.exit(2);
  }
  const schema = source.schema ?? "dbo";

  console.log(`>>> server   : ${source.server ?? source.mssqlUrl}`);
  console.log(`>>> database : ${source.database ?? "(from url)"}`);
  console.log(`>>> schema   : ${schema}`);
  console.log(
    `>>> mode     : ${checkOnly ? "check-only (ไม่แก้อะไร)" : "create if missing"}`,
  );
  if (only) console.log(`>>> only     : ${only.join(", ")}`);
  if (includeOptional) console.log(">>> optional : รวม spec ที่ mark optional");

  let pool = null;
  try {
    pool = await sql.connect(buildMssqlConfig(source));
    const out = await ensureMigrateIndexes(pool, {
      schema,
      checkOnly,
      includeOptional,
      only,
    });
    console.log(
      `>>> edition  : EngineEdition ${out.engineEdition}${
        out.onlineClause
          ? " (สร้างแบบ ONLINE ได้)"
          : " (สร้างแบบ offline — ล็อกเขียนชั่วคราว)"
      }`,
    );
    printSummary(out);
  } catch (err) {
    console.error(
      `>>> failed   : ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      ">>> ต่อ MSSQL ไม่ได้ หรือ user ไม่มีสิทธิ์ ALTER — รัน --check-only แล้ว copy DDL ไปรันใน SSMS ด้วย user ที่มีสิทธิ์แทนได้",
    );
    process.exitCode = 1;
  } finally {
    if (pool) await pool.close();
  }
}

const invokedDirectly =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
