/**
 * Mapping: dbo.income + dbo.income2 -> public.center_income (แท็บ "รายรับศูนย์" หน้าการเงิน)
 *
 * คีย์ประจำแถว = old_db_id "income:ID" / "income2:ID" (ดู mssqlCenterIncomeSelect.mjs)
 *
 * ค่าที่เขียน (รหัสตามฟอร์มรายรับศูนย์ BIS-Backoffice finance/form-center-income.tsx):
 *   Income_type = 0 และ Donate_type = 0 → type "1" (ค่าบริการต่างๆ) + service_fee "1" (ขอ Copy CD)
 *                                          + donate_for = PID (ฟอร์มเก็บรหัสผู้ป่วยของค่าบริการไว้ช่องนี้)
 *   ที่เหลือ                              → type "0" (บริจาค), service_fee ว่าง
 *   Income_date  → date_time_created (เวลาไทยไม่มี tz — แท็บกรองวันด้วยช่องนี้)
 *                 + date_created (timestamptz ของเวลาเดียวกัน — แท็บใช้เรียงแถว)
 *   Receipt → amount, Receipt_No → receipt_number, FullName → full_name
 *   PID → patient_info (ไม่สนตัวพิมพ์ แถวจริงก่อน placeholder) PID ว่าง/"0" ไม่ผูก หาไม่เจอ = NULL + field issue
 *   Mobile = 1 → location = CENTER_INCOME_MOBILE_LOCATION, ไม่ใช่ → Location_ID ตามเดิม
 *     (ค่าที่ไม่มีในตารางที่ FK ชี้ = NULL + field issue)
 *   status "0" (ใช้งาน — ยกเลิกในระบบใหม่ = "1")
 *
 * migrateRowMode:
 *   insert-only (resume / migrate:all ทุกคืน) — insert เฉพาะคีย์ใหม่ ไม่ทับข้อมูลแถวเดิม
 *       แต่เติม patient_info ของแถวเดิมที่ยังเป็น NULL ถ้ารอบนี้หาเจอ (เช่นคนไข้ถูก migrate ทีหลัง)
 *   overwrite — แถวเดิมเขียนช่องที่มาจากต้นทางทับให้ตรง (ไม่แตะ status ที่ยกเลิกในระบบใหม่,
 *       donate_for ของบริจาคคงค่าเดิม, patient_info หาไม่เจอคงค่าเดิม)
 * แถวที่ไม่มี old_db_id (บันทึกในระบบใหม่) ไม่ถูกแตะทุกโหมด
 */

import { createChunkFieldIssueCollector } from "../../shared/js-migrate/stagingFieldIssues.mjs";
import {
  patientPidMatchSql,
  patientPidPreferenceOrderSql,
} from "../../shared/js-migrate/patientPidMatch.mjs";
import {
  CENTER_INCOME_STAGING_COLUMNS,
  CENTER_INCOME_STAGING_TABLE,
} from "./centerIncomePgDdl.mjs";

const STAGING_TABLE = CENTER_INCOME_STAGING_TABLE;
const THAI_TIME_ZONE = "Asia/Bangkok";

const TYPE_DONATION = "0";
const TYPE_SERVICE = "1";
const SERVICE_FEE_COPY_CD = "1";
const STATUS_ACTIVE = "0";

/**
 * location ของเคสหน่วยตรวจเคลื่อนที่ (Mobile = 1) — center_income.location ผูก collection place
 * (1 TYR, 2 ICS, 3 MOBILE, 5 สภากาชาดไทย) user ยืนยัน 2026-11-10
 * หมายเหตุ: หน้า "รายรับศูนย์" ของ Backoffice ยังอ่านช่องนี้ด้วย location-mapping (TYR=1, MOBILE=2, ICS=3)
 */
export const CENTER_INCOME_MOBILE_LOCATION = 3;

/** "income2:" + Income_ID (int สูงสุด 10 หลัก) */
const OLD_DB_ID_MIN_LENGTH = 20;

/** คอลัมน์ปลายทางที่ต้องมีครบ — ขาดตัวไหนหยุดเลย (ไม่ข้ามเงียบๆ แล้วข้อมูลหาย) */
const REQUIRED_TARGET_COLUMNS = [
  "old_db_id",
  "type",
  "service_fee",
  "donate_for",
  "amount",
  "receipt_number",
  "date_time_created",
  "date_created",
  "full_name",
  "location",
  "patient_info",
  "status",
];

/** ช่องที่มาจากต้นทาง (overwrite เขียนทับชุดนี้) */
const SOURCE_DATA_COLUMNS = [
  "type",
  "service_fee",
  "donate_for",
  "amount",
  "receipt_number",
  "date_time_created",
  "date_created",
  "full_name",
  "location",
];

function q(ident) {
  return `"${ident}"`;
}

function nullIfTrimEmpty(value) {
  if (value == null) return null;
  const t = String(value).replace(/^﻿/, "").trim();
  return t === "" ? null : t;
}

/** คีย์อ้างแถวใน log / --source-ids / repair-from-log = old_db_id เช่น income:339323 */
export function centerIncomeRowKey(row) {
  return nullIfTrimEmpty(row?.old_db_id);
}

/** MSSQL row -> staging shape (ข้อความ, ค่าว่าง = null); ไม่มีคีย์ = null (ข้ามแถว) */
export function normalizeCenterIncomeMssqlRow(raw) {
  /** @type {Record<string, string | null>} */
  const out = {};
  for (const col of CENTER_INCOME_STAGING_COLUMNS) {
    out[col] = nullIfTrimEmpty(raw?.[col]);
  }
  if (out.old_db_id == null) return null;
  return out;
}

let targetMetaCache = null;

/** เรียกก่อนรัน migrate เผื่อ schema ปลายทางเปลี่ยนใน session เดียวกัน */
export function resetCenterIncomeTargetColumnCache() {
  targetMetaCache = null;
}

/**
 * คอลัมน์ปลายทาง + ตารางที่ FK ของ location ชี้ (ฐานจริงชี้ public.place) — ใช้กันค่า location ที่ไม่มีอยู่จริง
 * @returns {Promise<{ cols: Map<string, any>, locationRef: { schema: string, table: string, column: string } | null }>}
 */
async function getTargetMeta(pgClient) {
  if (targetMetaCache) return targetMetaCache;
  const r = await pgClient.query(
    `SELECT column_name, data_type, character_maximum_length
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'center_income'`,
  );
  const cols = new Map(r.rows.map((x) => [x.column_name, x]));
  if (cols.size === 0) {
    throw new Error("ไม่พบตาราง public.center_income ในฐานปลายทาง");
  }
  const missing = REQUIRED_TARGET_COLUMNS.filter((c) => !cols.has(c));
  if (missing.length > 0) {
    throw new Error(
      `public.center_income ไม่มีคอลัมน์ ${missing.join(", ")} — สร้างฟิลด์ใน Directus ให้ครบก่อน`,
    );
  }
  // คีย์เป็นข้อความ "income2:364480" (ยาวสุดราว 20 ตัว) — ฟิลด์ตัวเลข/สั้นเกินจะเขียนไม่ลงหรือถูกตัดจนเทียบแถวเดิมไม่ได้
  const oldDbId = cols.get("old_db_id");
  const oldDbIdLen = Number(oldDbId.character_maximum_length ?? 0);
  const isText = ["character varying", "text", "character"].includes(oldDbId.data_type);
  if (!isText || (oldDbIdLen > 0 && oldDbIdLen < OLD_DB_ID_MIN_LENGTH)) {
    throw new Error(
      `public.center_income.old_db_id เป็น ${oldDbId.data_type}${oldDbIdLen > 0 ? `(${oldDbIdLen})` : ""}` +
        ` — ต้องเป็นข้อความยาวอย่างน้อย ${OLD_DB_ID_MIN_LENGTH} ตัว (เก็บรูป "income:339323" / "income2:10") แก้ชนิดฟิลด์ใน Directus ก่อน`,
    );
  }
  const fk = await pgClient.query(`
    SELECT nf.nspname AS ref_schema, cf.relname AS ref_table, af.attname AS ref_column
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = con.conkey[1]
    JOIN pg_class cf ON cf.oid = con.confrelid
    JOIN pg_namespace nf ON nf.oid = cf.relnamespace
    JOIN pg_attribute af ON af.attrelid = cf.oid AND af.attnum = con.confkey[1]
    WHERE con.contype = 'f'
      AND n.nspname = 'public' AND c.relname = 'center_income'
      AND a.attname = 'location'
      AND array_length(con.conkey, 1) = 1
    LIMIT 1
  `);
  const ref = fk.rows[0];
  targetMetaCache = {
    cols,
    locationRef: ref
      ? { schema: ref.ref_schema, table: ref.ref_table, column: ref.ref_column }
      : null,
  };
  return targetMetaCache;
}

/** ตัดความยาวให้พอดีคอลัมน์ varchar ปลายทาง */
function fitLen(expr, meta) {
  const maxLen = Number(meta?.character_maximum_length ?? 0);
  return Number.isFinite(maxLen) && maxLen > 0 ? `LEFT(${expr}, ${maxLen})` : expr;
}

function intOf(col) {
  const t = `NULLIF(btrim(s.${q(col)}), '')`;
  return `(CASE WHEN ${t} ~ '^-?[0-9]{1,9}$' THEN ${t}::int END)`;
}

/** PID ที่ใช้ผูกคนไข้ — ว่าง / "0" (ผู้บริจาคไม่ระบุตัว) = ไม่ผูก */
const PID_SQL = `NULLIF(NULLIF(btrim(s.${q("pid")}), ''), '0')`;

/**
 * แปลงแถว staging เป็นค่าระหว่างทาง (ยังไม่ตัดความยาว) — ใช้ร่วมกันทั้งเขียนปลายทางและ field issue
 * @param {{ schema: string, table: string, column: string } | null} locationRef
 */
function decodedSelectSql(locationRef) {
  const amountText = `replace(btrim(s.${q("receipt")}), ',', '')`;
  const dateText = `btrim(s.${q("income_date")})`;
  const locRaw = `(CASE WHEN COALESCE(${intOf("mobile")} = 1, false) THEN ${CENTER_INCOME_MOBILE_LOCATION} ELSE ${intOf("location_id")} END)`;
  const locChecked = locationRef
    ? `(SELECT f.${q(locationRef.column)} FROM ${q(locationRef.schema)}.${q(locationRef.table)} f WHERE f.${q(locationRef.column)} = ${locRaw})`
    : locRaw;
  return `
  SELECT
    s.${q("old_db_id")} AS old_db_id,
    s.r_patient,
    (COALESCE(${intOf("income_type")} = 0, false) AND COALESCE(${intOf("donate_type")} = 0, false)) AS is_service,
    ${PID_SQL} AS pid_n,
    (CASE WHEN ${amountText} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN ${amountText}::numeric END) AS amount,
    NULLIF(btrim(s.${q("receipt_no")}), '') AS receipt_no_n,
    (CASE WHEN ${dateText} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN ${dateText}::timestamp END) AS dt,
    NULLIF(btrim(s.${q("full_name")}), '') AS full_name_n,
    ${locRaw} AS loc_raw,
    ${locChecked} AS loc
  FROM ${STAGING_TABLE} s`.trim();
}

/**
 * CTE "mapped": 1 แถวต่อ staging — คอลัมน์ชื่อเดียวกับปลายทาง พร้อมเขียน
 * @param {Awaited<ReturnType<typeof getTargetMeta>>} meta
 */
function mappedCteSql(meta) {
  const { cols, locationRef } = meta;
  return `
mapped AS (
  SELECT
    x.old_db_id,
    x.r_patient AS patient_info,
    CASE WHEN x.is_service THEN '${TYPE_SERVICE}' ELSE '${TYPE_DONATION}' END AS ${q("type")},
    CASE WHEN x.is_service THEN '${SERVICE_FEE_COPY_CD}' END AS service_fee,
    CASE WHEN x.is_service THEN ${fitLen("x.pid_n", cols.get("donate_for"))} END AS donate_for,
    x.amount,
    ${fitLen("x.receipt_no_n", cols.get("receipt_number"))} AS receipt_number,
    x.dt AS date_time_created,
    (x.dt AT TIME ZONE '${THAI_TIME_ZONE}') AS date_created,
    ${fitLen("x.full_name_n", cols.get("full_name"))} AS full_name,
    x.loc AS location,
    '${STATUS_ACTIVE}' AS status
  FROM (
${decodedSelectSql(locationRef)}
  ) x
)`.trim();
}

/** เติม r_patient ใน staging ครั้งเดียวต่อ chunk */
async function resolvePatient(pgClient) {
  await pgClient.query(
    `
UPDATE ${STAGING_TABLE} s SET
  r_patient = (
    SELECT pi.id FROM public.patient_info pi
    WHERE ${patientPidMatchSql("pi", PID_SQL)}
    ORDER BY ${patientPidPreferenceOrderSql("pi", PID_SQL)}
    LIMIT 1
  )
WHERE ${PID_SQL} IS NOT NULL
`.trim(),
  );
}

/**
 * @param {import("pg").PoolClient} pgClient
 * @param {object[]} normalizedRows
 * @returns {Promise<{ loaded: number, duplicateKeys: string[] }>}
 */
async function loadChunkToStaging(pgClient, normalizedRows) {
  const cols = CENTER_INCOME_STAGING_COLUMNS;
  const arrays = cols.map(() => []);
  /** คีย์มาจาก "ตาราง:Income_ID" ของต้นทางซึ่งไม่ซ้ำอยู่แล้ว — กันไว้เผื่ออ่านแถวเดิมซ้ำตอน OFFSET เลื่อน */
  const seen = new Set();
  /** @type {string[]} */
  const duplicateKeys = [];
  for (const r of normalizedRows) {
    if (!r) continue;
    const key = centerIncomeRowKey(r);
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

/** วันที่/ยอดแปลงไม่ได้ / ยาวเกินคอลัมน์ / location ไม่มีจริง / หาคนไข้ไม่เจอ / คีย์ซ้ำ — ลง field-issue log */
async function collectFieldIssues(pgClient, meta, duplicateKeys) {
  const collector = createChunkFieldIssueCollector("center_income_key");
  const { cols } = meta;
  const lenOf = (c) => {
    const n = Number(cols.get(c)?.character_maximum_length ?? 0);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const nameLen = lenOf("full_name");
  const receiptLen = lenOf("receipt_number");

  const { rows } = await pgClient.query(
    `
SELECT * FROM (
  SELECT
    s.*,
    x.pid_n,
    x.loc_raw,
    (x.dt IS NULL) AS f_date,
    (NULLIF(btrim(s.${q("receipt")}), '') IS NOT NULL AND x.amount IS NULL) AS f_amount,
    (x.pid_n IS NOT NULL AND s.r_patient IS NULL) AS f_patient,
    (x.loc_raw IS NOT NULL AND x.loc IS NULL) AS f_location,
    ${nameLen ? `COALESCE(char_length(x.full_name_n) > ${nameLen}, false)` : "false"} AS f_long_name,
    ${receiptLen ? `COALESCE(char_length(x.receipt_no_n) > ${receiptLen}, false)` : "false"} AS f_long_receipt
  FROM ${STAGING_TABLE} s
  INNER JOIN (
${decodedSelectSql(meta.locationRef)}
  ) x ON x.old_db_id = s.${q("old_db_id")}
) y
WHERE f_date OR f_amount OR f_patient OR f_location OR f_long_name OR f_long_receipt
ORDER BY y.${q("old_db_id")}
`.trim(),
  );

  for (const r of rows) {
    /** @type {object[]} */
    const issues = [];
    if (r.f_date) {
      issues.push({
        field: "date_time_created",
        reason: r.income_date == null ? "value_missing" : "value_not_parsed",
        message:
          "Income_date ว่างหรือแปลงเป็นวันที่ไม่ได้ — date_time_created เป็น NULL (แท็บรายรับศูนย์กรองตามวัน แถวนี้จะไม่โผล่)",
        source_raw: r.income_date,
        mapped: null,
      });
    }
    if (r.f_amount) {
      issues.push({
        field: "amount",
        reason: "value_not_parsed",
        message: "Receipt แปลงเป็นตัวเลขไม่ได้ — amount เป็น NULL",
        source_raw: r.receipt,
        mapped: null,
      });
    }
    if (r.f_location) {
      issues.push({
        field: "location",
        reason: "value_not_in_reference",
        message: `location ${r.loc_raw} ไม่มีในตารางที่ FK ชี้ — เป็น NULL`,
        source_raw: { mobile: r.mobile, location_id: r.location_id },
        mapped: null,
      });
    }
    if (r.f_long_name) {
      issues.push({
        field: "full_name",
        reason: "value_truncated",
        message: `ยาวเกิน ${nameLen} ตัวอักษร — ตัดให้พอดีคอลัมน์ปลายทาง`,
        source_raw: r.full_name,
        mapped: String(r.full_name).trim().slice(0, nameLen),
      });
    }
    if (r.f_long_receipt) {
      issues.push({
        field: "receipt_number",
        reason: "value_truncated",
        message: `ยาวเกิน ${receiptLen} ตัวอักษร — ตัดให้พอดีคอลัมน์ปลายทาง`,
        source_raw: r.receipt_no,
        mapped: String(r.receipt_no).trim().slice(0, receiptLen),
      });
    }
    if (r.f_patient) {
      issues.push({
        field: "patient_info",
        reason: "patient_info_not_resolved",
        message: "หา PID ไม่เจอใน patient_info.pid / old_db_id — ไม่ผูกคนไข้ (รอบหน้าจะลองหาใหม่)",
        source_raw: { pid: r.pid },
        mapped: null,
      });
    }
    collector.recordIssues(r.old_db_id, { pid: r.pid ?? null }, issues);
  }

  for (const key of duplicateKeys) {
    collector.recordIssues(key, {}, [
      {
        field: "old_db_id",
        reason: "duplicate_key_in_source",
        message: "อ่านคีย์เดียวกันซ้ำใน chunk (OFFSET เลื่อนระหว่างอ่าน) — เก็บแถวแรก",
        source_raw: key,
        mapped: null,
      },
    ]);
  }
  return collector.buildChunkResult(0);
}

/**
 * โหลด chunk ลง staging, resolve patient_info แล้วเขียน public.center_income ตาม old_db_id
 *
 * @param {import("pg").PoolClient} pgClient
 * @param {object[]} normalizedRows
 * @param {{ migrateRowMode?: "overwrite" | "insert-only" }} [options]
 */
export async function runCenterIncomeChunkPostLoad(
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
    patientWanted: 0,
    patientResolved: 0,
    copyCdRows: 0,
    donationRows: 0,
    fieldIssues: null,
  };
  if (!normalizedRows || normalizedRows.length === 0) return empty;

  const meta = await getTargetMeta(pgClient);
  const { loaded, duplicateKeys } = await loadChunkToStaging(
    pgClient,
    normalizedRows,
  );
  if (loaded === 0) return { ...empty, duplicateKeys: duplicateKeys.length };

  await resolvePatient(pgClient);

  const overwrite = (options.migrateRowMode ?? "overwrite") !== "insert-only";
  const mapped = mappedCteSql(meta);

  const existing = await pgClient.query(
    `
SELECT COUNT(*)::bigint AS cnt
FROM ${STAGING_TABLE} s
WHERE EXISTS (SELECT 1 FROM public.center_income t WHERE t.old_db_id = s.${q("old_db_id")})
`.trim(),
  );
  const rowsExisting = Number(existing.rows[0]?.cnt ?? 0);

  // แถวเดิมก่อน insert — ไม่งั้นแถวที่เพิ่ง insert ใน chunk นี้ถูกนับเป็น "อัปเดต"
  let rowsUpdated = 0;
  let rowsRelationFilled = 0;
  if (overwrite) {
    const setExpr = (c) => {
      if (c === "donate_for") {
        // บริจาค: donate_for = วัตถุประสงค์ที่เลือกในระบบใหม่ (ต้นทางไม่มี) — คงค่าเดิม
        return `CASE WHEN m.${q("type")} = '${TYPE_SERVICE}' THEN m.donate_for ELSE t.donate_for END`;
      }
      return `m.${q(c)}`;
    };
    const relAfter = "COALESCE(m.patient_info, t.patient_info)";
    const upd = await pgClient.query(
      `
WITH ${mapped}
UPDATE public.center_income AS t
SET ${[...SOURCE_DATA_COLUMNS.map((c) => `${q(c)} = ${setExpr(c)}`), `patient_info = ${relAfter}`].join(",\n    ")}
FROM mapped m
WHERE t.old_db_id = m.old_db_id
  AND (${[...SOURCE_DATA_COLUMNS.map((c) => `t.${q(c)}`), "t.patient_info"].join(", ")})
      IS DISTINCT FROM (${[...SOURCE_DATA_COLUMNS.map(setExpr), relAfter].join(", ")})
`.trim(),
    );
    rowsUpdated = upd.rowCount ?? 0;
  } else {
    const upd = await pgClient.query(
      `
UPDATE public.center_income AS t
SET patient_info = s.r_patient
FROM ${STAGING_TABLE} s
WHERE t.old_db_id = s.${q("old_db_id")}
  AND t.patient_info IS NULL AND s.r_patient IS NOT NULL
`.trim(),
    );
    rowsRelationFilled = upd.rowCount ?? 0;
  }

  const insertCols = ["old_db_id", ...SOURCE_DATA_COLUMNS, "patient_info", "status"];
  const ins = await pgClient.query(
    `
WITH ${mapped}
INSERT INTO public.center_income (${insertCols.map(q).join(", ")})
SELECT ${insertCols.map((c) => `m.${q(c)}`).join(", ")}
FROM mapped m
WHERE NOT EXISTS (SELECT 1 FROM public.center_income t WHERE t.old_db_id = m.old_db_id)
ORDER BY m.date_time_created NULLS LAST, m.old_db_id
`.trim(),
  );
  const rowsInserted = ins.rowCount ?? 0;

  const stats = await pgClient.query(
    `
SELECT
  count(*) FILTER (WHERE ${PID_SQL} IS NOT NULL)::int AS wanted,
  count(r_patient)::int AS ok,
  count(*) FILTER (
    WHERE COALESCE(${intOf("income_type")} = 0, false) AND COALESCE(${intOf("donate_type")} = 0, false)
  )::int AS copy_cd
FROM ${STAGING_TABLE} s
`.trim(),
  );
  const copyCdRows = Number(stats.rows[0]?.copy_cd ?? 0);
  const issues = await collectFieldIssues(pgClient, meta, duplicateKeys);
  if (issues.fieldIssues) issues.fieldIssues.rowsInserted = rowsInserted;

  return {
    rowsLoadedToStaging: loaded,
    rowsInserted,
    rowsUpdated,
    rowsRelationFilled,
    rowsSkippedExisting: overwrite ? 0 : rowsExisting,
    duplicateKeys: duplicateKeys.length,
    patientWanted: Number(stats.rows[0]?.wanted ?? 0),
    patientResolved: Number(stats.rows[0]?.ok ?? 0),
    copyCdRows,
    donationRows: loaded - copyCdRows,
    fieldIssues: issues.fieldIssues,
  };
}
