/**
 * Mapping: dbo.SPECIAL_CASE -> public.special_case
 *
 * คีย์ประจำแถว = (old_pid, sequence) ตาม PK ต้นทาง — Sequence นับใหม่ต่อคนไข้ จึงใช้คู่กับ PID เสมอ
 * คอลัมน์ข้อมูลเขียนตามชนิดคอลัมน์ปลายทางจริง (อ่าน information_schema) แปลงไม่ได้ = NULL + field issue
 *
 * relation patient_info (ไม่มีต้นทาง) — public.patient_info.id จาก old_pid
 *   (ไม่สนตัวพิมพ์ แถวจริงก่อน placeholder) หาไม่เจอ = NULL + field issue ไม่สร้าง placeholder
 *
 * migrateRowMode:
 *   insert-only (resume / migrate:all ทุกคืน) — insert เฉพาะคีย์ที่ยังไม่มีปลายทาง ไม่ทับข้อมูลแถวเดิม
 *       แต่เติม patient_info ของแถวเดิมที่ยังเป็น NULL ถ้ารอบนี้หาเจอ (เช่นคนไข้ถูก migrate ทีหลัง)
 *   overwrite — แถวเดิมเขียนข้อมูลทับให้ตรงต้นทาง; patient_info ใช้ค่าที่หาได้ ถ้าหาไม่เจอคงค่าเดิมไว้
 * แถวปลายทางที่ไม่มีคู่ในต้นทาง (คนเพิ่มเองในระบบใหม่) ไม่ถูกแตะทุกโหมด
 */

import { createChunkFieldIssueCollector } from "../../shared/js-migrate/stagingFieldIssues.mjs";
import {
  patientPidMatchSql,
  patientPidPreferenceOrderSql,
} from "../../shared/js-migrate/patientPidMatch.mjs";
import {
  SPECIAL_CASE_STAGING_COLUMNS,
  SPECIAL_CASE_STAGING_TABLE,
} from "./specialCasePgDdl.mjs";

const STAGING_TABLE = SPECIAL_CASE_STAGING_TABLE;
const KEY_COLUMNS = ["old_pid", "sequence"];
const DATA_COLUMNS = SPECIAL_CASE_STAGING_COLUMNS.filter((c) => !KEY_COLUMNS.includes(c));
const RELATION_COLUMN = "patient_info";

function q(ident) {
  return `"${ident}"`;
}

function nullIfTrimEmpty(value) {
  if (value == null) return null;
  const t = String(value).replace(/^﻿/, "").trim();
  return t === "" ? null : t;
}

/** คีย์อ้างแถวใน log / --source-ids / repair-from-log: "PID|Sequence" */
export function specialCaseRowKey(row) {
  const pid = nullIfTrimEmpty(row?.old_pid);
  const seq = nullIfTrimEmpty(row?.sequence);
  if (pid == null || seq == null) return null;
  return `${pid}|${seq}`;
}

/** MSSQL row -> staging shape (ข้อความ, ค่าว่าง = null); ไม่มี PID หรือ Sequence = null (ข้ามแถว) */
export function normalizeSpecialCaseMssqlRow(raw) {
  /** @type {Record<string, string | null>} */
  const out = {};
  for (const col of SPECIAL_CASE_STAGING_COLUMNS) {
    out[col] = nullIfTrimEmpty(raw?.[col]);
  }
  if (out.old_pid == null || out.sequence == null) return null;
  return out;
}

let targetColumnsCache = null;

/** เรียกก่อนรัน migrate เผื่อ schema ปลายทางเปลี่ยนใน session เดียวกัน */
export function resetSpecialCaseTargetColumnCache() {
  targetColumnsCache = null;
}

/** ฟิลด์ทั้ง 6 ตัวต้องมีครบ — ขาดตัวไหนหยุดเลย (ไม่ข้ามเงียบๆ แล้วข้อมูลหาย) */
async function getTargetColumns(pgClient) {
  if (targetColumnsCache) return targetColumnsCache;
  const r = await pgClient.query(
    `SELECT column_name, data_type, character_maximum_length
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'special_case'`,
  );
  const cols = new Map(r.rows.map((x) => [x.column_name, x]));
  if (cols.size === 0) {
    throw new Error("ไม่พบตาราง public.special_case ในฐานปลายทาง");
  }
  const missing = [...SPECIAL_CASE_STAGING_COLUMNS, RELATION_COLUMN].filter((c) => !cols.has(c));
  if (missing.length > 0) {
    throw new Error(
      `public.special_case ไม่มีคอลัมน์ ${missing.join(", ")} — สร้างฟิลด์ใน Directus ให้ครบก่อน`,
    );
  }
  targetColumnsCache = cols;
  return cols;
}

/**
 * ข้อความใน staging → ค่าที่จะเขียนลงคอลัมน์ปลายทาง ตามชนิดคอลัมน์จริง
 * แปลงไม่ได้ = NULL (ไม่ให้ทั้ง chunk ล้ม) — collectFieldIssues จับไปลง log
 */
function toTargetValueExpr(baseExpr, meta) {
  const t = `NULLIF(btrim(${baseExpr}), '')`;
  switch (meta.data_type) {
    case "smallint":
    case "integer":
    case "bigint":
      return `CASE WHEN ${t} ~ '^-?[0-9]{1,18}$' THEN ${t}::bigint END`;
    case "numeric":
    case "real":
    case "double precision":
      return `CASE WHEN ${t} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN ${t}::numeric END`;
    case "character varying":
    case "character": {
      const maxLen = Number(meta.character_maximum_length ?? 0);
      return Number.isFinite(maxLen) && maxLen > 0 ? `LEFT(${t}, ${maxLen})` : t;
    }
    default:
      return t;
  }
}

/** แถวปลายทาง t คือแถวเดียวกับ staging s — เทียบด้วยค่าที่จะถูกเขียนจริง (ชนิด/ความยาวเดียวกัน) */
function keyMatchSql(cols) {
  return KEY_COLUMNS.map(
    (c) => `t.${q(c)} = ${toTargetValueExpr(`s.${q(c)}`, cols.get(c))}`,
  ).join(" AND ");
}

/** คีย์แปลงเป็นชนิดคอลัมน์ปลายทางได้ (ไม่งั้นเทียบไม่ได้ → insert ซ้ำทุกคืน จึงไม่ insert) */
function keyMappableSql(cols) {
  return KEY_COLUMNS.map(
    (c) => `(${toTargetValueExpr(`s.${q(c)}`, cols.get(c))}) IS NOT NULL`,
  ).join(" AND ");
}

/** เติม r_patient ใน staging ครั้งเดียวต่อ chunk */
async function resolvePatient(pgClient) {
  const pid = `s.${q("old_pid")}`;
  await pgClient.query(
    `
UPDATE ${STAGING_TABLE} s SET
  r_patient = (
    SELECT pi.id FROM public.patient_info pi
    WHERE ${patientPidMatchSql("pi", pid)}
    ORDER BY ${patientPidPreferenceOrderSql("pi", pid)}
    LIMIT 1
  )
`.trim(),
  );
}

/**
 * @param {import("pg").PoolClient} pgClient
 * @param {object[]} normalizedRows
 * @returns {Promise<{ loaded: number, duplicateKeys: string[] }>}
 */
async function loadChunkToStaging(pgClient, normalizedRows) {
  const cols = SPECIAL_CASE_STAGING_COLUMNS;
  const arrays = cols.map(() => []);
  /** staging เป็น PK (old_pid, sequence) — ต้นทางมี PK เดียวกันจึงไม่ควรซ้ำ กันไว้เผื่อ PID ต่างแค่ช่องว่าง */
  const seen = new Set();
  /** @type {string[]} */
  const duplicateKeys = [];
  for (const r of normalizedRows) {
    if (!r) continue;
    const key = specialCaseRowKey(r);
    if (seen.has(key)) {
      duplicateKeys.push(key);
      continue;
    }
    seen.add(key);
    for (let i = 0; i < cols.length; i++) {
      arrays[i].push(r[cols[i]] ?? null);
    }
  }
  await pgClient.query(`TRUNCATE TABLE ${STAGING_TABLE};`);
  if (arrays[0].length === 0) return { loaded: 0, duplicateKeys };
  const castArgs = cols.map((_, i) => `$${i + 1}::text[]`).join(", ");
  await pgClient.query(
    `
INSERT INTO ${STAGING_TABLE} (${cols.map(q).join(", ")})
SELECT * FROM unnest(${castArgs});
`.trim(),
    arrays,
  );
  return { loaded: arrays[0].length, duplicateKeys };
}

/** ค่าแปลงไม่ได้ / ยาวเกินคอลัมน์ / หาคนไข้ไม่เจอ / คีย์ซ้ำ — ลง field-issue log */
async function collectFieldIssues(pgClient, cols, duplicateKeys) {
  const collector = createChunkFieldIssueCollector("special_case_key");
  const dataCols = SPECIAL_CASE_STAGING_COLUMNS;
  const flagSelects = [];
  const flagNames = [];

  flagSelects.push(`NOT (${keyMappableSql(cols)}) AS f_key`);
  flagNames.push("f_key");
  dataCols.forEach((c, i) => {
    const meta = cols.get(c);
    const raw = `NULLIF(btrim(s.${q(c)}), '')`;
    flagSelects.push(
      `(${raw} IS NOT NULL AND (${toTargetValueExpr(`s.${q(c)}`, meta)}) IS NULL) AS f_bad_${i}`,
    );
    flagNames.push(`f_bad_${i}`);
    const maxLen = Number(meta.character_maximum_length ?? 0);
    if (Number.isFinite(maxLen) && maxLen > 0) {
      flagSelects.push(`COALESCE(char_length(${raw}) > ${maxLen}, false) AS f_long_${i}`);
      flagNames.push(`f_long_${i}`);
    }
  });
  flagSelects.push("(s.r_patient IS NULL) AS f_patient");
  flagNames.push("f_patient");

  const { rows } = await pgClient.query(
    `
SELECT * FROM (
  SELECT s.*, ${flagSelects.join(",\n    ")}
  FROM ${STAGING_TABLE} s
) x
WHERE ${flagNames.join(" OR ")}
ORDER BY x.${q("old_pid")}, x.${q("sequence")}
`.trim(),
  );

  for (const r of rows) {
    /** @type {object[]} */
    const issues = [];
    if (r.f_key) {
      issues.push({
        field: "sequence",
        reason: "key_not_mappable",
        message:
          "PID/Sequence แปลงเป็นชนิดคอลัมน์ปลายทางไม่ได้ — ไม่ insert (เทียบซ้ำกับรอบหน้าไม่ได้)",
        source_raw: { old_pid: r.old_pid, sequence: r.sequence },
        mapped: null,
      });
    }
    dataCols.forEach((c, i) => {
      if (r[`f_bad_${i}`]) {
        issues.push({
          field: c,
          reason: "value_not_parsed",
          message: `แปลงเป็นชนิด ${cols.get(c).data_type} ของปลายทางไม่ได้ — เขียนเป็น NULL`,
          source_raw: r[c],
          mapped: null,
        });
      }
      if (r[`f_long_${i}`]) {
        const maxLen = Number(cols.get(c).character_maximum_length);
        issues.push({
          field: c,
          reason: "value_truncated",
          message: `ยาวเกิน ${maxLen} ตัวอักษร — ตัดให้พอดีคอลัมน์ปลายทาง`,
          source_raw: r[c],
          mapped: String(r[c]).trim().slice(0, maxLen),
        });
      }
    });
    if (r.f_patient) {
      issues.push({
        field: RELATION_COLUMN,
        reason: "patient_info_not_resolved",
        message: "หา PID ไม่เจอใน patient_info.pid / old_db_id — เป็น NULL (รอบหน้าจะลองหาใหม่)",
        source_raw: { old_pid: r.old_pid },
        mapped: null,
      });
    }
    collector.recordIssues(
      `${r.old_pid}|${r.sequence}`,
      { old_pid: r.old_pid, sequence: r.sequence },
      issues,
    );
  }

  for (const key of duplicateKeys) {
    collector.recordIssues(key, {}, [
      {
        field: "sequence",
        reason: "duplicate_key_in_source",
        message:
          "ต้นทางมี (PID, Sequence) ซ้ำหลังตัดช่องว่าง — เก็บแถวแรกแถวเดียว (คีย์ใช้เทียบแถวเดิมทุกคืน เก็บซ้ำไม่ได้)",
        source_raw: key,
        mapped: null,
      },
    ]);
  }
  return collector.buildChunkResult(0);
}

/**
 * โหลด chunk ลง staging, resolve patient_info แล้วเขียน public.special_case ตามคีย์ (old_pid, sequence)
 *
 * @param {import("pg").PoolClient} pgClient
 * @param {object[]} normalizedRows
 * @param {{ migrateRowMode?: "overwrite" | "insert-only" }} [options]
 */
export async function runSpecialCaseChunkPostLoad(
  pgClient,
  normalizedRows,
  options = {},
) {
  const empty = {
    rowsLoadedToStaging: 0,
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsRelationFilled: 0,
    rowsSkippedExisting: 0,
    duplicateKeys: 0,
    patientResolved: 0,
    fieldIssues: null,
  };
  if (!normalizedRows || normalizedRows.length === 0) return empty;

  const cols = await getTargetColumns(pgClient);
  const { loaded, duplicateKeys } = await loadChunkToStaging(
    pgClient,
    normalizedRows,
  );
  if (loaded === 0) return { ...empty, duplicateKeys: duplicateKeys.length };

  await resolvePatient(pgClient);

  const overwrite = (options.migrateRowMode ?? "overwrite") !== "insert-only";
  const match = keyMatchSql(cols);
  const rel = q(RELATION_COLUMN);
  const dataExpr = (c) => toTargetValueExpr(`s.${q(c)}`, cols.get(c));

  const existing = await pgClient.query(
    `
SELECT COUNT(*)::bigint AS cnt
FROM ${STAGING_TABLE} s
WHERE EXISTS (SELECT 1 FROM public.special_case t WHERE ${match})
`.trim(),
  );
  const rowsExisting = Number(existing.rows[0]?.cnt ?? 0);

  // แถวเดิมก่อน insert — ไม่งั้นแถวที่เพิ่ง insert ใน chunk นี้ถูกนับเป็น "อัปเดต"
  let rowsUpdated = 0;
  let rowsRelationFilled = 0;
  if (overwrite) {
    const relAfter = `COALESCE(s.r_patient, t.${rel})`;
    const upd = await pgClient.query(
      `
UPDATE public.special_case AS t
SET ${[...DATA_COLUMNS.map((c) => `${q(c)} = ${dataExpr(c)}`), `${rel} = ${relAfter}`].join(",\n    ")}
FROM ${STAGING_TABLE} s
WHERE ${match}
  AND (${[...DATA_COLUMNS.map((c) => `t.${q(c)}`), `t.${rel}`].join(", ")})
      IS DISTINCT FROM (${[...DATA_COLUMNS.map(dataExpr), relAfter].join(", ")})
`.trim(),
    );
    rowsUpdated = upd.rowCount ?? 0;
  } else {
    const upd = await pgClient.query(
      `
UPDATE public.special_case AS t
SET ${rel} = s.r_patient
FROM ${STAGING_TABLE} s
WHERE ${match}
  AND t.${rel} IS NULL AND s.r_patient IS NOT NULL
`.trim(),
    );
    rowsRelationFilled = upd.rowCount ?? 0;
  }

  const ins = await pgClient.query(
    `
INSERT INTO public.special_case (${[...SPECIAL_CASE_STAGING_COLUMNS.map(q), rel].join(", ")})
SELECT
  ${[...SPECIAL_CASE_STAGING_COLUMNS.map(dataExpr), "s.r_patient"].join(",\n  ")}
FROM ${STAGING_TABLE} s
WHERE ${keyMappableSql(cols)}
  AND NOT EXISTS (SELECT 1 FROM public.special_case t WHERE ${match})
ORDER BY s.${q("old_pid")}, s.${q("sequence")}
`.trim(),
  );
  const rowsInserted = ins.rowCount ?? 0;

  const resolved = await pgClient.query(
    `SELECT count(r_patient)::int AS ok FROM ${STAGING_TABLE}`,
  );
  const issues = await collectFieldIssues(pgClient, cols, duplicateKeys);
  if (issues.fieldIssues) issues.fieldIssues.rowsInserted = rowsInserted;

  return {
    rowsLoadedToStaging: loaded,
    rowsInserted,
    rowsUpdated,
    rowsRelationFilled,
    rowsSkippedExisting: overwrite ? 0 : rowsExisting,
    duplicateKeys: duplicateKeys.length,
    patientResolved: Number(resolved.rows[0]?.ok ?? 0),
    fieldIssues: issues.fieldIssues,
  };
}
