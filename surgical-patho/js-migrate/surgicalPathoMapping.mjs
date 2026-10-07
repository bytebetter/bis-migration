/**
 * Mapping: dbo.SURGICAL_PATHO -> public.surgical_patho
 *
 * คีย์ประจำแถว = (old_pid, old_surgical_id) — Surgical_ID นับใหม่ต่อคนไข้ จึงใช้คู่กับ PID เสมอ
 * คอลัมน์ข้อมูลเขียนตามชนิดคอลัมน์ปลายทางจริง (อ่าน information_schema) แปลงไม่ได้ = NULL + field issue
 *
 * relation (ไม่มีต้นทาง — resolve จากเลขเดิม; หาไม่เจอ = NULL + field issue):
 *   patient_info — public.patient_info.id จาก old_pid (ไม่สนตัวพิมพ์ แถวจริงก่อน placeholder)
 *   exam         — public.examination.id จาก old_exam_id = examination.old_exam_id
 *   procedure    — public.procedure.id จาก procedure.old_db_id = "<old_exam_id>_<old_biopsy_id>"
 *                  (ต้นทางคือ dbo.biopsy คีย์ Exam_ID + BiopsyID — BiopsyID เดี่ยวๆ ซ้ำกันทุก exam)
 *   last_exam    — public.examination.id จาก old_last_exam_id
 *
 * migrateRowMode:
 *   insert-only (resume / migrate:all ทุกคืน) — insert เฉพาะคีย์ที่ยังไม่มีปลายทาง ไม่ทับข้อมูลแถวเดิม
 *       แต่เติม relation ของแถวเดิมที่ยังเป็น NULL ถ้ารอบนี้หาเจอ (เช่น exam/procedure ถูก migrate ทีหลัง)
 *   overwrite — แถวเดิมเขียนข้อมูลทับให้ตรงต้นทาง; relation ใช้ค่าที่หาได้ ถ้าหาไม่เจอคงค่าเดิมไว้
 * แถวปลายทางที่ไม่มีคู่ในต้นทาง (คนเพิ่มเองในระบบใหม่) ไม่ถูกแตะทุกโหมด
 */

import { createChunkFieldIssueCollector } from "../../shared/js-migrate/stagingFieldIssues.mjs";
import {
  patientPidMatchSql,
  patientPidPreferenceOrderSql,
} from "../../shared/js-migrate/patientPidMatch.mjs";
import {
  SURGICAL_PATHO_STAGING_COLUMNS,
  SURGICAL_PATHO_STAGING_TABLE,
} from "./surgicalPathoPgDdl.mjs";

const STAGING_TABLE = SURGICAL_PATHO_STAGING_TABLE;
const KEY_COLUMNS = ["old_pid", "old_surgical_id"];

/** relation ปลายทาง → id ที่ resolve ไว้ใน staging + คอลัมน์ต้นทางที่ต้องมีค่าถึงจะหา */
export const SURGICAL_PATHO_RELATIONS = [
  { column: "patient_info", resolved: "r_patient", needs: ["old_pid"], lookup: "patient_info.pid" },
  { column: "exam", resolved: "r_exam", needs: ["old_exam_id"], lookup: "examination.old_exam_id" },
  {
    column: "procedure",
    resolved: "r_procedure",
    needs: ["old_exam_id", "old_biopsy_id"],
    lookup: 'procedure.old_db_id ("<Exam_ID>_<BiopsyID>")',
  },
  { column: "last_exam", resolved: "r_last_exam", needs: ["old_last_exam_id"], lookup: "examination.old_exam_id" },
];

const INT_TYPES = new Set(["smallint", "integer", "bigint"]);

/** วันที่แบบ ISO ที่ CONVERT style 126 ให้มา (มี/ไม่มีเวลา, มี/ไม่มีเศษวินาที) */
const DATE_TEXT_RE =
  "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])([ T][0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]+)?)?)?$";

function q(ident) {
  return `"${ident}"`;
}

function nullIfTrimEmpty(value) {
  if (value == null) return null;
  const t = String(value).replace(/^﻿/, "").trim();
  return t === "" ? null : t;
}

/** คีย์อ้างแถวใน log / --source-ids / repair-from-log: "PID|Surgical_ID" */
export function surgicalPathoRowKey(row) {
  const pid = nullIfTrimEmpty(row?.old_pid);
  const sid = nullIfTrimEmpty(row?.old_surgical_id);
  if (pid == null || sid == null) return null;
  return `${pid}|${sid}`;
}

/** MSSQL row -> staging shape (ข้อความ, ค่าว่าง = null); ไม่มี PID หรือ Surgical_ID = null (ข้ามแถว) */
export function normalizeSurgicalPathoMssqlRow(raw) {
  /** @type {Record<string, string | null>} */
  const out = {};
  for (const col of SURGICAL_PATHO_STAGING_COLUMNS) {
    out[col] = nullIfTrimEmpty(raw?.[col]);
  }
  if (out.old_pid == null || out.old_surgical_id == null) return null;
  return out;
}

let targetColumnsCache = null;
let lookupColumnsCache = null;

/** เรียกก่อนรัน migrate เผื่อ schema ปลายทางเปลี่ยนใน session เดียวกัน */
export function resetSurgicalPathoTargetColumnCache() {
  targetColumnsCache = null;
  lookupColumnsCache = null;
}

async function columnsOf(pgClient, tableName) {
  const r = await pgClient.query(
    `SELECT column_name, data_type, character_maximum_length
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName],
  );
  return new Map(r.rows.map((x) => [x.column_name, x]));
}

/** ฟิลด์ทั้ง 15 ตัวต้องมีครบ — ขาดตัวไหนหยุดเลย (ไม่ข้ามเงียบๆ แล้วข้อมูลหาย) */
async function getTargetColumns(pgClient) {
  if (targetColumnsCache) return targetColumnsCache;
  const cols = await columnsOf(pgClient, "surgical_patho");
  if (cols.size === 0) {
    throw new Error("ไม่พบตาราง public.surgical_patho ในฐานปลายทาง");
  }
  const missing = [
    ...SURGICAL_PATHO_STAGING_COLUMNS,
    ...SURGICAL_PATHO_RELATIONS.map((r) => r.column),
  ].filter((c) => !cols.has(c));
  if (missing.length > 0) {
    throw new Error(
      `public.surgical_patho ไม่มีคอลัมน์ ${missing.join(", ")} — สร้างฟิลด์ใน Directus ให้ครบก่อน`,
    );
  }
  targetColumnsCache = cols;
  return cols;
}

/** คอลัมน์ที่ใช้ resolve relation (null = ไม่มีในฐานปลายทาง → relation นั้นเป็น NULL ทั้งหมด) */
async function getLookupColumns(pgClient) {
  if (lookupColumnsCache) return lookupColumnsCache;
  const exam = await columnsOf(pgClient, "examination");
  const proc = await columnsOf(pgClient, "procedure");
  lookupColumnsCache = {
    examOldExamId: exam.get("old_exam_id") ?? null,
    procedureOldDbId: proc.get("old_db_id") ?? null,
  };
  return lookupColumnsCache;
}

/** คำเตือนก่อนเริ่ม: ตารางที่ใช้ resolve ไม่มีคอลัมน์ old_* (เช่นยังไม่เคยรัน step examination / procedure) */
export async function surgicalPathoLookupWarnings(pgClient) {
  const lookups = await getLookupColumns(pgClient);
  /** @type {string[]} */
  const warnings = [];
  if (!lookups.examOldExamId) {
    warnings.push(
      "public.examination ไม่มีคอลัมน์ old_exam_id — exam / last_exam จะเป็น NULL ทุกแถว (รัน migrate:examination ก่อน)",
    );
  }
  if (!lookups.procedureOldDbId) {
    warnings.push(
      'public."procedure" ไม่มีคอลัมน์ old_db_id — procedure จะเป็น NULL ทุกแถว (รัน migrate:procedure ก่อน)',
    );
  }
  return warnings;
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
    case "boolean":
      return `CASE
        WHEN lower(${t}) IN ('1','true','t','yes','y') THEN true
        WHEN lower(${t}) IN ('0','false','f','no','n') THEN false
      END`;
    case "date":
      return `CASE WHEN ${t} ~ '${DATE_TEXT_RE}' THEN ${t}::timestamp::date END`;
    case "timestamp without time zone":
      return `CASE WHEN ${t} ~ '${DATE_TEXT_RE}' THEN ${t}::timestamp END`;
    case "timestamp with time zone":
      // ต้นทางเป็นเวลาไทยแบบไม่มีโซน
      return `CASE WHEN ${t} ~ '${DATE_TEXT_RE}' THEN (${t}::timestamp AT TIME ZONE 'Asia/Bangkok') END`;
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
    (c) => `t.${q(c)} = ${toTargetValueExpr(`s.${c}`, cols.get(c))}`,
  ).join(" AND ");
}

/** คีย์แปลงเป็นชนิดคอลัมน์ปลายทางได้ (ไม่งั้นเทียบไม่ได้ → insert ซ้ำทุกคืน จึงไม่ insert) */
function keyMappableSql(cols) {
  return KEY_COLUMNS.map(
    (c) => `(${toTargetValueExpr(`s.${c}`, cols.get(c))}) IS NOT NULL`,
  ).join(" AND ");
}

/** เทียบคอลัมน์ old id ของตาราง lookup กับข้อความเลขใน staging (รองรับทั้ง varchar และ integer) */
function oldIdEqSql(colSql, meta, textExpr) {
  if (INT_TYPES.has(meta.data_type)) {
    return `${colSql} = CASE WHEN ${textExpr} ~ '^-?[0-9]{1,18}$' THEN ${textExpr}::bigint END`;
  }
  return `${colSql} = ${textExpr}`;
}

/** เติม r_* ใน staging ครั้งเดียวต่อ chunk */
async function resolveRelations(pgClient, lookups) {
  const pid = "s.old_pid";
  const examLookup = (textExpr) =>
    lookups.examOldExamId == null
      ? "NULL"
      : `(
    SELECT e.id FROM public.examination e
    WHERE ${oldIdEqSql("e.old_exam_id", lookups.examOldExamId, textExpr)}
    ORDER BY e.id
    LIMIT 1
  )`;
  const procedureLookup =
    lookups.procedureOldDbId == null
      ? "NULL"
      : `(
    SELECT p.id FROM public."procedure" p
    WHERE p.old_db_id = (s.old_exam_id || '_' || s.old_biopsy_id)
    ORDER BY p.id
    LIMIT 1
  )`;
  await pgClient.query(
    `
UPDATE ${STAGING_TABLE} s SET
  r_patient = (
    SELECT pi.id FROM public.patient_info pi
    WHERE ${patientPidMatchSql("pi", pid)}
    ORDER BY ${patientPidPreferenceOrderSql("pi", pid)}
    LIMIT 1
  ),
  r_exam = ${examLookup("s.old_exam_id")},
  r_procedure = ${procedureLookup},
  r_last_exam = ${examLookup("s.old_last_exam_id")}
`.trim(),
  );
}

/**
 * @param {import("pg").PoolClient} pgClient
 * @param {object[]} normalizedRows
 * @returns {Promise<{ loaded: number, duplicateKeys: string[] }>}
 */
async function loadChunkToStaging(pgClient, normalizedRows) {
  const cols = SURGICAL_PATHO_STAGING_COLUMNS;
  const arrays = cols.map(() => []);
  /** staging เป็น PK (old_pid, old_surgical_id) — คีย์ซ้ำในต้นทางเก็บแถวแรก ที่เหลือลง field issue */
  const seen = new Set();
  /** @type {string[]} */
  const duplicateKeys = [];
  for (const r of normalizedRows) {
    if (!r) continue;
    const key = surgicalPathoRowKey(r);
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
INSERT INTO ${STAGING_TABLE} (${cols.join(", ")})
SELECT * FROM unnest(${castArgs});
`.trim(),
    arrays,
  );
  return { loaded: arrays[0].length, duplicateKeys };
}

/** จำนวนแถวที่มีเลขเดิม / หา relation เจอ ใน chunk นี้ (ใช้ทำสรุปท้ายรอบ) */
async function relationStats(pgClient) {
  const { rows } = await pgClient.query(
    `
SELECT
  count(*)::int AS patient_info_has,
  count(r_patient)::int AS patient_info_ok,
  count(*) FILTER (WHERE old_exam_id IS NOT NULL)::int AS exam_has,
  count(r_exam)::int AS exam_ok,
  count(*) FILTER (WHERE old_exam_id IS NOT NULL AND old_biopsy_id IS NOT NULL)::int AS procedure_has,
  count(r_procedure)::int AS procedure_ok,
  count(*) FILTER (WHERE old_last_exam_id IS NOT NULL)::int AS last_exam_has,
  count(r_last_exam)::int AS last_exam_ok
FROM ${STAGING_TABLE}
`.trim(),
  );
  const r = rows[0] ?? {};
  /** @type {Record<string, { has: number, ok: number }>} */
  const out = {};
  for (const rel of SURGICAL_PATHO_RELATIONS) {
    out[rel.column] = {
      has: Number(r[`${rel.column}_has`] ?? 0),
      ok: Number(r[`${rel.column}_ok`] ?? 0),
    };
  }
  return out;
}

/** ค่าแปลงไม่ได้ / ยาวเกินคอลัมน์ / หา relation ไม่เจอ / คีย์ซ้ำในต้นทาง — ลง field-issue log */
async function collectFieldIssues(pgClient, cols, duplicateKeys) {
  const collector = createChunkFieldIssueCollector("surgical_key");
  const dataCols = SURGICAL_PATHO_STAGING_COLUMNS;
  const flagSelects = [];
  const flagNames = [];

  flagSelects.push(`NOT (${keyMappableSql(cols)}) AS f_key`);
  flagNames.push("f_key");
  dataCols.forEach((c, i) => {
    const meta = cols.get(c);
    const raw = `NULLIF(btrim(s.${c}), '')`;
    flagSelects.push(
      `(${raw} IS NOT NULL AND (${toTargetValueExpr(`s.${c}`, meta)}) IS NULL) AS f_bad_${i}`,
    );
    flagNames.push(`f_bad_${i}`);
    const maxLen = Number(meta.character_maximum_length ?? 0);
    if (Number.isFinite(maxLen) && maxLen > 0) {
      flagSelects.push(`COALESCE(char_length(${raw}) > ${maxLen}, false) AS f_long_${i}`);
      flagNames.push(`f_long_${i}`);
    }
  });
  SURGICAL_PATHO_RELATIONS.forEach((rel, i) => {
    const has = rel.needs.map((c) => `s.${c} IS NOT NULL`).join(" AND ");
    flagSelects.push(`(${has} AND s.${rel.resolved} IS NULL) AS f_rel_${i}`);
    flagNames.push(`f_rel_${i}`);
  });

  const { rows } = await pgClient.query(
    `
SELECT * FROM (
  SELECT s.*, ${flagSelects.join(",\n    ")}
  FROM ${STAGING_TABLE} s
) x
WHERE ${flagNames.join(" OR ")}
ORDER BY x.old_pid, x.old_surgical_id
`.trim(),
  );

  for (const r of rows) {
    /** @type {object[]} */
    const issues = [];
    if (r.f_key) {
      issues.push({
        field: "old_surgical_id",
        reason: "key_not_mappable",
        message:
          "PID/Surgical_ID แปลงเป็นชนิดคอลัมน์ปลายทางไม่ได้ — ไม่ insert (เทียบซ้ำกับรอบหน้าไม่ได้)",
        source_raw: { old_pid: r.old_pid, old_surgical_id: r.old_surgical_id },
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
    SURGICAL_PATHO_RELATIONS.forEach((rel, i) => {
      if (!r[`f_rel_${i}`]) return;
      issues.push({
        field: rel.column,
        reason: `${rel.column}_not_resolved`,
        message: `มีเลขเดิมในต้นทาง แต่หาไม่เจอใน ${rel.lookup} — เป็น NULL (รอบหน้าจะลองหาใหม่)`,
        source_raw: Object.fromEntries(rel.needs.map((c) => [c, r[c]])),
        mapped: null,
      });
    });
    const key = `${r.old_pid}|${r.old_surgical_id}`;
    collector.recordIssues(
      key,
      { old_pid: r.old_pid, old_surgical_id: r.old_surgical_id },
      issues,
    );
  }

  for (const key of duplicateKeys) {
    collector.recordIssues(key, {}, [
      {
        field: "old_surgical_id",
        reason: "duplicate_key_in_source",
        message:
          "ต้นทางมี (PID, Surgical_ID) ซ้ำ — เก็บแถวแรกแถวเดียว (คีย์ใช้เทียบแถวเดิมทุกคืน เก็บซ้ำไม่ได้)",
        source_raw: key,
        mapped: null,
      },
    ]);
  }
  return collector.buildChunkResult(0);
}

/**
 * โหลด chunk ลง staging, resolve relation แล้วเขียน public.surgical_patho ตามคีย์ (old_pid, old_surgical_id)
 *
 * @param {import("pg").PoolClient} pgClient
 * @param {object[]} normalizedRows
 * @param {{ migrateRowMode?: "overwrite" | "insert-only" }} [options]
 */
export async function runSurgicalPathoChunkPostLoad(
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
    relationStats: null,
    fieldIssues: null,
  };
  if (!normalizedRows || normalizedRows.length === 0) return empty;

  const cols = await getTargetColumns(pgClient);
  const lookups = await getLookupColumns(pgClient);
  const { loaded, duplicateKeys } = await loadChunkToStaging(
    pgClient,
    normalizedRows,
  );
  if (loaded === 0) return { ...empty, duplicateKeys: duplicateKeys.length };

  await resolveRelations(pgClient, lookups);

  const overwrite = (options.migrateRowMode ?? "overwrite") !== "insert-only";
  const match = keyMatchSql(cols);
  const dataCols = SURGICAL_PATHO_STAGING_COLUMNS;
  const dataExprs = dataCols.map((c) => toTargetValueExpr(`s.${c}`, cols.get(c)));

  const existing = await pgClient.query(
    `
SELECT COUNT(*)::bigint AS cnt
FROM ${STAGING_TABLE} s
WHERE EXISTS (SELECT 1 FROM public.surgical_patho t WHERE ${match})
`.trim(),
  );
  const rowsExisting = Number(existing.rows[0]?.cnt ?? 0);

  // แถวเดิมก่อน insert — ไม่งั้นแถวที่เพิ่ง insert ใน chunk นี้ถูกนับเป็น "อัปเดต"
  let rowsUpdated = 0;
  let rowsRelationFilled = 0;
  if (overwrite) {
    const setData = dataCols
      .filter((c) => !KEY_COLUMNS.includes(c))
      .map((c) => `${q(c)} = ${dataExprs[dataCols.indexOf(c)]}`);
    const setRel = SURGICAL_PATHO_RELATIONS.map(
      (rel) => `${q(rel.column)} = COALESCE(s.${rel.resolved}, t.${q(rel.column)})`,
    );
    const before = [
      ...dataCols.filter((c) => !KEY_COLUMNS.includes(c)).map((c) => `t.${q(c)}`),
      ...SURGICAL_PATHO_RELATIONS.map((rel) => `t.${q(rel.column)}`),
    ];
    const after = [
      ...dataCols
        .filter((c) => !KEY_COLUMNS.includes(c))
        .map((c) => dataExprs[dataCols.indexOf(c)]),
      ...SURGICAL_PATHO_RELATIONS.map(
        (rel) => `COALESCE(s.${rel.resolved}, t.${q(rel.column)})`,
      ),
    ];
    const upd = await pgClient.query(
      `
UPDATE public.surgical_patho AS t
SET ${[...setData, ...setRel].join(",\n    ")}
FROM ${STAGING_TABLE} s
WHERE ${match}
  AND (${before.join(", ")}) IS DISTINCT FROM (${after.join(", ")})
`.trim(),
    );
    rowsUpdated = upd.rowCount ?? 0;
  } else {
    const setRel = SURGICAL_PATHO_RELATIONS.map(
      (rel) => `${q(rel.column)} = COALESCE(t.${q(rel.column)}, s.${rel.resolved})`,
    );
    const anyFillable = SURGICAL_PATHO_RELATIONS.map(
      (rel) => `(t.${q(rel.column)} IS NULL AND s.${rel.resolved} IS NOT NULL)`,
    ).join(" OR ");
    const upd = await pgClient.query(
      `
UPDATE public.surgical_patho AS t
SET ${setRel.join(",\n    ")}
FROM ${STAGING_TABLE} s
WHERE ${match}
  AND (${anyFillable})
`.trim(),
    );
    rowsRelationFilled = upd.rowCount ?? 0;
  }

  const insertCols = [
    ...dataCols.map(q),
    ...SURGICAL_PATHO_RELATIONS.map((rel) => q(rel.column)),
  ];
  const insertExprs = [
    ...dataExprs,
    ...SURGICAL_PATHO_RELATIONS.map((rel) => `s.${rel.resolved}`),
  ];
  const ins = await pgClient.query(
    `
INSERT INTO public.surgical_patho (${insertCols.join(", ")})
SELECT
  ${insertExprs.join(",\n  ")}
FROM ${STAGING_TABLE} s
WHERE ${keyMappableSql(cols)}
  AND NOT EXISTS (SELECT 1 FROM public.surgical_patho t WHERE ${match})
ORDER BY s.old_pid, s.old_surgical_id
`.trim(),
  );
  const rowsInserted = ins.rowCount ?? 0;

  const stats = await relationStats(pgClient);
  const issues = await collectFieldIssues(pgClient, cols, duplicateKeys);
  if (issues.fieldIssues) issues.fieldIssues.rowsInserted = rowsInserted;

  return {
    rowsLoadedToStaging: loaded,
    rowsInserted,
    rowsUpdated,
    rowsRelationFilled,
    rowsSkippedExisting: overwrite ? 0 : rowsExisting,
    duplicateKeys: duplicateKeys.length,
    relationStats: stats,
    fieldIssues: issues.fieldIssues,
  };
}
