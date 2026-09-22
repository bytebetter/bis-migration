/**
 * Mapping: dbo.MOBILE_LOCATION -> public.mobile_location
 *
 * ปลายทางมี 3 คอลัมน์: id (sequence ของ Directus), name, old_id
 *   old_id = [ID] ของ MSSQL — เป็นคีย์เทียบว่าแถวนี้ migrate มาแล้วหรือยัง
 *   name   = [Name] ตัดช่องว่างหัวท้าย; ค่าว่าง = NULL (ปลายทางเป็น varchar nullable)
 *
 * migrateRowMode:
 *   insert-only (ดีฟอลต์ของ resume) — insert เฉพาะ old_id ที่ยังไม่มีปลายทาง
 *                                      ไม่แตะชื่อที่แก้ไว้ในระบบใหม่
 *   overwrite                       — อัปเดตชื่อของ old_id ที่มีอยู่แล้วให้ตรงต้นทางด้วย
 *
 * แถวปลายทางที่ old_id ว่าง (คนเพิ่มเองในระบบใหม่) ไม่ถูกแตะทุกโหมด
 */

import { createChunkFieldIssueCollector } from "../../shared/js-migrate/stagingFieldIssues.mjs";
import {
  MOBILE_LOCATION_STAGING_COLUMNS,
  MOBILE_LOCATION_STAGING_TABLE,
} from "./mobileLocationPgDdl.mjs";

const INT_RE = /^-?\d+$/;
const STAGING_TABLE = MOBILE_LOCATION_STAGING_TABLE;

function getField(row, key) {
  return row[key] ?? row[key.toLowerCase()] ?? row[key.toUpperCase()];
}

function nullIfTrimEmpty(value) {
  if (value == null) return null;
  const t = String(value).trim();
  return t === "" ? null : t;
}

/** MSSQL row -> staging shape; old_id ไม่ใช่เลข = ข้ามแถว (map ไม่ได้) */
export function normalizeMobileLocationMssqlRow(raw) {
  const oldId = nullIfTrimEmpty(getField(raw, "old_id") ?? getField(raw, "ID"));
  if (oldId == null || !INT_RE.test(oldId)) return null;
  return {
    old_id: String(Number.parseInt(oldId, 10)),
    name:
      nullIfTrimEmpty(getField(raw, "name") ?? getField(raw, "Name")) ?? "",
  };
}

/** คีย์อ้างแถวใน chunk log / repair-from-log */
export function mobileLocationLogKey(row) {
  return nullIfTrimEmpty(getField(row, "old_id") ?? getField(row, "ID"));
}

let targetColumnsCache = null;

/** เรียกก่อนรัน migrate เผื่อ schema ปลายทางเปลี่ยนใน session เดียวกัน */
export function resetMobileLocationTargetColumnCache() {
  targetColumnsCache = null;
}

async function getTargetColumns(pgClient) {
  if (targetColumnsCache) return targetColumnsCache;
  const r = await pgClient.query(
    `SELECT column_name, data_type, character_maximum_length
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'mobile_location'`,
  );
  targetColumnsCache = new Map(r.rows.map((x) => [x.column_name, x]));
  return targetColumnsCache;
}

/** ความยาวสูงสุดของ public.mobile_location.name (varchar(255) ใน baseline) */
function nameMaxLength(cols) {
  const meta = cols.get("name");
  const n = Number(meta?.character_maximum_length ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function nameExpr(maxLen) {
  const trimmed = "NULLIF(btrim(s.name), '')";
  return maxLen == null ? trimmed : `LEFT(${trimmed}, ${maxLen})`;
}

export async function loadChunkToStaging(pgClient, normalizedRows) {
  const cols = MOBILE_LOCATION_STAGING_COLUMNS;
  const arrays = cols.map(() => []);
  /** ต้นทางมี ID เป็น PK แต่กัน id ซ้ำใน chunk ไว้ (staging เป็น PK) */
  const seen = new Set();
  for (const r of normalizedRows) {
    if (!r || seen.has(r.old_id)) continue;
    seen.add(r.old_id);
    for (let i = 0; i < cols.length; i++) {
      arrays[i].push(r[cols[i]] ?? "");
    }
  }
  if (arrays[0].length === 0) return 0;
  await pgClient.query(`TRUNCATE TABLE ${STAGING_TABLE};`);
  const castArgs = cols.map((_, i) => `$${i + 1}::text[]`).join(", ");
  await pgClient.query(
    `
INSERT INTO ${STAGING_TABLE} (${cols.join(", ")})
SELECT * FROM unnest(${castArgs});
`.trim(),
    arrays,
  );
  return arrays[0].length;
}

/** ชื่อว่าง / ชื่อยาวเกินคอลัมน์ปลายทาง — บันทึกไว้ใน field-issue log */
async function collectMobileLocationFieldIssues(pgClient, maxLen) {
  const collector = createChunkFieldIssueCollector("old_id");
  const { rows } = await pgClient.query(
    `
    SELECT
      s.old_id,
      s.name,
      NULLIF(btrim(s.name), '') IS NULL AS name_empty,
      ${maxLen == null ? "false" : `char_length(btrim(s.name)) > ${maxLen}`} AS name_too_long
    FROM ${STAGING_TABLE} s
    WHERE NULLIF(btrim(s.name), '') IS NULL
      ${maxLen == null ? "" : `OR char_length(btrim(s.name)) > ${maxLen}`}
    ORDER BY s.old_id::bigint
    `,
  );
  for (const r of rows) {
    /** @type {object[]} */
    const issues = [];
    if (r.name_empty) {
      issues.push({
        field: "name",
        reason: "name_empty",
        message: "ต้นทางไม่มีชื่อสถานที่ — ปลายทางเป็น NULL",
        source_raw: r.name ?? null,
        mapped: null,
      });
    }
    if (r.name_too_long) {
      issues.push({
        field: "name",
        reason: "name_truncated",
        message: `ชื่อยาวเกิน ${maxLen} ตัวอักษร — ตัดให้พอดีคอลัมน์ปลายทาง`,
        source_raw: r.name,
        mapped: String(r.name).trim().slice(0, maxLen),
      });
    }
    collector.recordIssues(r.old_id, { old_id: String(r.old_id) }, issues);
  }
  return collector.buildChunkResult(0);
}

/**
 * โหลด chunk ลง staging แล้ว insert/update public.mobile_location ตาม old_id
 *
 * @param {{ migrateRowMode?: "overwrite" | "insert-only" }} [options]
 * @returns {Promise<{ rowsLoadedToStaging: number, rowsInserted: number, rowsUpdated: number, rowsUnchanged: number, rowsSkippedExisting: number, fieldIssues: object|null }>}
 */
export async function runMobileLocationChunkPostLoad(
  pgClient,
  normalizedRows,
  options = {},
) {
  const empty = {
    rowsLoadedToStaging: 0,
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsUnchanged: 0,
    rowsSkippedExisting: 0,
    fieldIssues: null,
  };
  if (!normalizedRows || normalizedRows.length === 0) return empty;

  const rowsLoadedToStaging = await loadChunkToStaging(pgClient, normalizedRows);
  if (rowsLoadedToStaging === 0) return empty;

  const cols = await getTargetColumns(pgClient);
  if (cols.size === 0) {
    throw new Error("ไม่พบตาราง public.mobile_location ในฐานปลายทาง");
  }
  for (const required of ["name", "old_id"]) {
    if (!cols.has(required)) {
      throw new Error(
        `target public.mobile_location must have column "${required}"`,
      );
    }
  }

  const maxLen = nameMaxLength(cols);
  const name = nameExpr(maxLen);
  const overwrite = (options.migrateRowMode ?? "overwrite") !== "insert-only";

  const existing = await pgClient.query(
    `
SELECT COUNT(*)::bigint AS cnt
FROM ${STAGING_TABLE} s
WHERE EXISTS (
  SELECT 1 FROM public.mobile_location t WHERE t.old_id = s.old_id::int
)
`.trim(),
  );
  const rowsExisting = Number(existing.rows[0]?.cnt ?? 0);

  let rowsUpdated = 0;
  if (overwrite) {
    const upd = await pgClient.query(
      `
UPDATE public.mobile_location AS t
SET name = ${name}
FROM ${STAGING_TABLE} s
WHERE t.old_id = s.old_id::int
  AND t.name IS DISTINCT FROM ${name}
`.trim(),
    );
    rowsUpdated = upd.rowCount ?? 0;
  }

  const ins = await pgClient.query(
    `
INSERT INTO public.mobile_location (name, old_id)
SELECT ${name}, s.old_id::int
FROM ${STAGING_TABLE} s
WHERE NOT EXISTS (
  SELECT 1 FROM public.mobile_location t WHERE t.old_id = s.old_id::int
)
`.trim(),
  );
  const rowsInserted = ins.rowCount ?? 0;

  const issues = await collectMobileLocationFieldIssues(pgClient, maxLen);
  if (issues.fieldIssues) issues.fieldIssues.rowsInserted = rowsInserted;

  return {
    rowsLoadedToStaging,
    rowsInserted,
    rowsUpdated,
    rowsUnchanged: overwrite ? Math.max(0, rowsExisting - rowsUpdated) : 0,
    rowsSkippedExisting: overwrite ? 0 : rowsExisting,
    fieldIssues: issues.fieldIssues,
  };
}
