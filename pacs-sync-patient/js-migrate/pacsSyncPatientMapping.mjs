/**
 * Mapping: dbo.PACS_SYNC_PATIENT -> public.pacs_sync_patient
 *
 * ตาราง log ไม่มี PK — insert ทุกแถวที่อ่านจาก MSSQL ไม่ dedupe ตาม (UpdateTime, PID)
 * (แบบเดียวกับ appointment_reschedules: dedupe natural key เคยทำแถว log หายไปหลายหมื่น)
 *
 * คอลัมน์ปลายทางที่ไม่มีต้นทาง:
 *   patient   — resolve จาก old_pid (= [PID] ของ MSSQL) เทียบ patient_info.pid / old_db_id; ไม่เจอ = NULL
 *   file_name — MSSQL ไม่มีคอลัมน์นี้ (ระบบใหม่ตั้งชื่อไฟล์จาก accession_id ตอน sync) = NULL
 */

import { createChunkFieldIssueCollector } from "../../shared/js-migrate/stagingFieldIssues.mjs";
import {
  patientPidMatchSql,
  patientPidPreferenceOrderSql,
} from "../../shared/js-migrate/patientPidMatch.mjs";
import { PACS_SYNC_PATIENT_STAGING_COLUMNS } from "./pacsSyncPatientPgDdl.mjs";

const STAGING_TABLE = "migrate_stg.pacs_sync_patient_mssql";

/** คอลัมน์ปลายทางที่ห้ามเขียนจาก migrate (id มาจาก sequence, ที่เหลือ Directus จัดการ) */
const SKIP_TARGET_COLS = new Set([
  "id",
  "user_created",
  "date_created",
  "user_updated",
  "date_updated",
]);

/** NOT NULL ฝั่ง Postgres และ DEFAULT เป็น NULL — ต้องเขียน '' แทนค่าว่าง ไม่งั้น chunk ล้ม */
const NOT_NULL_TEXT_COLS = new Set(["update_time", "old_old_pid", "old_pid"]);

function getField(row, key) {
  return row[key] ?? row[key.toLowerCase()] ?? row[key.toUpperCase()];
}

function nullIfTrimEmpty(value) {
  if (value == null) return null;
  const t = String(value).trim();
  return t === "" ? null : t;
}

/** MSSQL row -> staging shape (ทุกฟิลด์เป็น text; ค่าว่าง = "") */
export function normalizePacsSyncPatientMssqlRow(raw) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const col of PACS_SYNC_PATIENT_STAGING_COLUMNS) {
    out[col] = nullIfTrimEmpty(getField(raw, col)) ?? "";
  }
  return out;
}

/** คีย์อ้างแถว log สำหรับ chunk log / repair-from-log (UpdateTime + PID) */
export function pacsSyncPatientLogKey(row) {
  const updateTime = nullIfTrimEmpty(getField(row, "update_time"));
  const pid = nullIfTrimEmpty(getField(row, "old_pid"));
  if (updateTime == null && pid == null) return null;
  return `${updateTime ?? ""}|${pid ?? ""}`;
}

async function existingColumns(pgClient, tableName) {
  const r = await pgClient.query(
    `SELECT column_name, data_type, udt_name, character_maximum_length
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName],
  );
  return new Map(r.rows.map((x) => [x.column_name, x]));
}

function toSqlValueExpr(baseExpr, colMeta) {
  const dt = colMeta.data_type;
  const udt = colMeta.udt_name;
  if (dt === "integer" || dt === "smallint" || dt === "bigint") {
    return `
      CASE
        WHEN ${baseExpr} IS NULL OR btrim(${baseExpr}::text) = '' THEN NULL
        WHEN btrim(${baseExpr}::text) ~ '^-?[0-9]+$' THEN btrim(${baseExpr}::text)::bigint
        ELSE NULL
      END`;
  }
  if (dt === "boolean") {
    return `CASE
      WHEN ${baseExpr} IS NULL OR btrim(${baseExpr}::text) = '' THEN NULL
      WHEN lower(btrim(${baseExpr}::text)) IN ('1','true','t','yes','y') THEN true
      WHEN lower(btrim(${baseExpr}::text)) IN ('0','false','f','no','n') THEN false
      ELSE NULL
    END`;
  }
  if (dt === "character varying") {
    const maxLen = Number(colMeta.character_maximum_length ?? 0);
    if (Number.isFinite(maxLen) && maxLen > 0) {
      return `LEFT(NULLIF(btrim(${baseExpr}::text), ''), ${maxLen})`;
    }
    return `NULLIF(btrim(${baseExpr}::text), '')`;
  }
  if (udt && udt.startsWith("_")) return null;
  return `NULLIF(btrim(${baseExpr}::text), '')`;
}

/** NOT NULL: ค่าว่างจากต้นทางเขียนเป็น '' (ตัดตามความยาวคอลัมน์) */
function toNotNullTextExpr(baseExpr, colMeta) {
  const maxLen = Number(colMeta.character_maximum_length ?? 0);
  const trimmed = `btrim(${baseExpr}::text)`;
  const capped =
    colMeta.data_type === "character varying" &&
    Number.isFinite(maxLen) &&
    maxLen > 0
      ? `LEFT(${trimmed}, ${maxLen})`
      : trimmed;
  return `COALESCE(${capped}, '')`;
}

let targetColumnsCache = null;

/** เรียกก่อนรัน migrate เผื่อ schema ปลายทางเปลี่ยนใน session เดียวกัน */
export function resetPacsSyncPatientTargetColumnCache() {
  targetColumnsCache = null;
}

async function getCachedTargetColumns(pgClient) {
  if (targetColumnsCache) return targetColumnsCache;
  targetColumnsCache = await existingColumns(pgClient, "pacs_sync_patient");
  return targetColumnsCache;
}

function rowToStagingArrays(rowObj, rowIdx, arrays, cols) {
  for (let c = 0; c < cols.length; c++) {
    const v = rowObj[cols[c]];
    arrays[c][rowIdx] = v === undefined || v === null ? null : String(v);
  }
}

async function loadChunkToStaging(pgClient, normalizedRows) {
  const cols = PACS_SYNC_PATIENT_STAGING_COLUMNS;
  const arrays = cols.map(() => []);
  for (let i = 0; i < normalizedRows.length; i++) {
    rowToStagingArrays(normalizedRows[i], i, arrays, cols);
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

/** แถวที่มี PID แต่หา patient_info ไม่เจอ — บันทึกไว้ใน field-issue log (ค่า patient เป็น NULL) */
async function collectPatientNotResolvedIssues(pgClient) {
  const collector = createChunkFieldIssueCollector("log_key");
  const { rows } = await pgClient.query(
    `
    SELECT DISTINCT
      NULLIF(btrim(s.update_time), '') AS update_time,
      NULLIF(btrim(s.old_pid), '') AS pid
    FROM ${STAGING_TABLE} s
    WHERE NULLIF(btrim(s.old_pid), '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.patient_info pi
        WHERE ${patientPidMatchSql("pi", "NULLIF(btrim(s.old_pid), '')")}
      )
    `,
  );
  for (const r of rows) {
    collector.recordIssues(
      `${r.update_time ?? ""}|${r.pid ?? ""}`,
      { update_time: r.update_time ?? null, pid: r.pid ?? null },
      [
        {
          field: "patient",
          reason: "patient_not_resolved",
          message: "มี PID ในแหล่งข้อมูล แต่ไม่พบใน public.patient_info",
          source_raw: r.pid,
          mapped: null,
        },
      ],
    );
  }
  return collector.buildChunkResult(0);
}

/**
 * โหลด chunk ลง staging แล้ว INSERT เข้า public.pacs_sync_patient (insert ทุกแถว ไม่ลบของเดิม)
 *
 * @returns {{ rowsWritten: number, rowsLoadedToStaging: number, fieldIssues: object|null }}
 */
export async function runPacsSyncPatientChunkPostLoad(pgClient, mssqlRows) {
  if (mssqlRows.length === 0) {
    return { rowsWritten: 0, rowsLoadedToStaging: 0, fieldIssues: null };
  }

  const normalized = mssqlRows.map((r) =>
    normalizePacsSyncPatientMssqlRow(r),
  );
  const rowsLoadedToStaging = await loadChunkToStaging(pgClient, normalized);

  const cols = await getCachedTargetColumns(pgClient);
  if (cols.size === 0) {
    throw new Error("ไม่พบตาราง public.pacs_sync_patient ในฐานปลายทาง");
  }
  if (!cols.has("update_time")) {
    throw new Error(
      'target public.pacs_sync_patient must have column "update_time"',
    );
  }

  const insertColumns = [];
  const selectExprs = [];
  for (const [name, meta] of cols.entries()) {
    if (SKIP_TARGET_COLS.has(name)) continue;

    let expr = null;
    if (name === "patient") {
      expr = "pat.id";
    } else if (name === "file_name") {
      // ต้นทางไม่มีชื่อไฟล์ — ปล่อย NULL ไม่เดาค่า
      continue;
    } else if (PACS_SYNC_PATIENT_STAGING_COLUMNS.includes(name)) {
      expr = NOT_NULL_TEXT_COLS.has(name)
        ? toNotNullTextExpr(`s.${name}`, meta)
        : toSqlValueExpr(`s.${name}`, meta);
    }

    if (expr) {
      insertColumns.push(name);
      selectExprs.push(expr);
    }
  }

  if (insertColumns.length === 0) {
    throw new Error("no writable columns mapped for public.pacs_sync_patient");
  }

  const ins = await pgClient.query(
    `
INSERT INTO public.pacs_sync_patient (${insertColumns.join(", ")})
SELECT
  ${selectExprs.join(",\n  ")}
FROM ${STAGING_TABLE} s
LEFT JOIN LATERAL (
  SELECT pi.id
  FROM public.patient_info pi
  WHERE NULLIF(btrim(s.old_pid), '') IS NOT NULL
    AND ${patientPidMatchSql("pi", "NULLIF(btrim(s.old_pid), '')")}
  ORDER BY ${patientPidPreferenceOrderSql("pi", "NULLIF(btrim(s.old_pid), '')")}
  LIMIT 1
) pat ON TRUE
`.trim(),
  );

  const rowsWritten = ins.rowCount ?? rowsLoadedToStaging;
  const issues = await collectPatientNotResolvedIssues(pgClient);
  if (issues.fieldIssues) issues.fieldIssues.rowsInserted = rowsWritten;

  return {
    rowsWritten,
    rowsLoadedToStaging,
    fieldIssues: issues.fieldIssues,
  };
}

export async function syncPacsSyncPatientIdSequence(pgClient) {
  await pgClient.query(`
    SELECT setval(
      pg_get_serial_sequence('public.pacs_sync_patient', 'id'),
      COALESCE((SELECT MAX(id) + 1 FROM public.pacs_sync_patient), 1),
      false
    )
    WHERE pg_get_serial_sequence('public.pacs_sync_patient', 'id') IS NOT NULL;
  `);
}

export async function resetPacsSyncPatientIdSequenceIfEmpty(pgClient) {
  await pgClient.query(`
    WITH cnt AS (
      SELECT COUNT(*)::bigint AS c FROM public.pacs_sync_patient
    )
    SELECT setval(
      pg_get_serial_sequence('public.pacs_sync_patient', 'id'),
      1,
      false
    )
    FROM cnt
    WHERE cnt.c = 0
      AND pg_get_serial_sequence('public.pacs_sync_patient', 'id') IS NOT NULL;
  `);
}
