/**
 * เก็บตกแถวที่ต้นทางมีแต่ Postgres ไม่มี (migrate:all resume ทุกคืน)
 *
 * ทำไมต้องมี: การ resume อ่านเฉพาะแถวที่อยู่หลัง checkpoint ตามลำดับ (CreatedDate ว่างก่อน → วันที่ → id)
 * แถวใหม่ที่ CreatedDate ว่าง / วันที่ย้อนหลัง / ตารางลูกที่เพิ่มให้ exam เก่า จะไปอยู่ก่อน checkpoint → ไม่ถูกอ่านอีกเลย
 *
 * วิธี: ตอน snapshot count (ต้นรอบ, นับย้อนลำดับ ลูก → แม่) เก็บรายการ key ต้นทางไว้ในไฟล์
 * หลังตารางนั้น migrate ตามปกติเสร็จ เทียบ key ในไฟล์กับ Postgres → ส่ง id ที่ขาดให้ migrate ตาราง
 * ผ่าน --source-ids (insert-only, ไม่เขียน checkpoint)
 * - แถวที่เกิดหลัง snapshot ไม่อยู่ในไฟล์ → ปล่อยให้รอบปกติคืนถัดไปอ่าน (ไม่ซ้อนกัน)
 * - ตารางที่ post-load ลบแล้วเขียนใหม่ทั้ง exam/accession: ส่งเฉพาะ exam/accession ที่ Postgres ยังไม่มีเลย
 *   ถ้ามีบางแถวอยู่แล้ว (partial) ข้ามและรายงาน — ไม่เขียนทับแถวที่แก้ในระบบใหม่
 */
import fs from "node:fs";
import readline from "node:readline";
import { PLACEHOLDER_FIRST_NAME_TH } from "../shared/js-migrate/ensurePlaceholderPatientInfo.mjs";

/** ตัด BOM + ช่องว่าง, ตัวเลขล้วนตัด 0 นำหน้า — ค่าว่างคืน null */
export function normKeyPart(v) {
  if (v == null) return null;
  const s = String(v).replace(/^﻿/, "").trim();
  if (s === "") return null;
  if (/^\d+$/.test(s)) return BigInt(s).toString();
  return s;
}

const EXAM_ID_SQL = "CONVERT(NVARCHAR(40), TRY_CAST([Exam_ID] AS BIGINT))";

/** ตารางละ 1 แถวต่อ Exam_ID (ปลายทางมี old_exam_id) */
function examKeyedSpec(dir, pgTable) {
  return {
    dir,
    sourceKeysSql: (src) =>
      `SELECT ${EXAM_ID_SQL} AS k FROM ${src} WHERE TRY_CAST([Exam_ID] AS BIGINT) IS NOT NULL`,
    toSourceUnit: (r) => {
      const k = normKeyPart(r.k);
      return k == null ? null : { key: k, send: k };
    },
    pgKeysSql: async () =>
      `SELECT old_exam_id::text AS k FROM public."${pgTable}" WHERE old_exam_id IS NOT NULL`,
    toPgUnit: (r) => {
      const k = normKeyPart(r[0]);
      return k == null ? null : { key: k, send: k };
    },
  };
}

/** ตารางลูก (Exam_ID, child id) — --source-ids รับ Exam_ID แล้วดึงลูกทุกตัวของ exam นั้น */
function examChildSpec(dir, pgTable, childColumn) {
  const childPg = childColumn.toLowerCase();
  return {
    dir,
    sourceKeysSql: (src) =>
      `SELECT ${EXAM_ID_SQL} AS e, CONVERT(NVARCHAR(40), TRY_CAST([${childColumn}] AS BIGINT)) AS c FROM ${src} WHERE TRY_CAST([Exam_ID] AS BIGINT) IS NOT NULL AND TRY_CAST([${childColumn}] AS BIGINT) IS NOT NULL`,
    toSourceUnit: (r) => {
      const e = normKeyPart(r.e);
      const c = normKeyPart(r.c);
      return e == null || c == null ? null : { key: `${e}_${c}`, send: e };
    },
    // ปลายทางมี old_exam_id หรือผูก exam → examination.id (แบบเดียวกับ mapping ของตาราง)
    pgKeysSql: async (client) => {
      const { rows } = await client.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'old_exam_id'`,
        [pgTable],
      );
      return rows.length > 0
        ? `SELECT t.old_exam_id::text AS e, t.${childPg}::text AS c FROM public."${pgTable}" t`
        : `SELECT e.old_exam_id::text AS e, t.${childPg}::text AS c FROM public."${pgTable}" t JOIN public.examination e ON e.id = t.exam`;
    },
    toPgUnit: (r) => {
      const e = normKeyPart(r[0]);
      const c = normKeyPart(r[1]);
      return e == null || c == null ? null : { key: `${e}_${c}`, send: e };
    },
  };
}

/**
 * sourceKeysSql → แถวต้นทาง (อ่าน NOLOCK) → toSourceUnit
 * pgKeysSql → แถว Postgres (rowMode array) → toPgUnit / pgUnitsFromRow
 * key = หน่วยที่เทียบ, send = ค่าที่ส่งให้ --source-ids ของตาราง
 * @type {Record<string, { dir: string, multiset?: boolean, sourceKeysSql: (src: string) => string, toSourceUnit: (row: any) => ({ key: string, send: string } | null), pgKeysSql: (client: any) => Promise<string>, pgParams?: unknown[], toPgUnit?: (row: any[]) => ({ key: string, send: string } | null), pgUnitsFromRow?: (row: any[]) => { key: string, send: string | null }[] }>}
 */
export const CATCH_UP_SPECS = {
  // PID ไม่สนตัวพิมพ์ (ตาม patientPidMatch) — placeholder ถือว่ายังขาด → --source-ids อัปเกรดเป็นข้อมูลจริง
  patient_info: {
    dir: "patient-info",
    sourceKeysSql: (src) =>
      `SELECT CONVERT(NVARCHAR(256), [PID]) AS k FROM ${src} WHERE [PID] IS NOT NULL`,
    toSourceUnit: (r) => {
      const pid = normPid(r.k);
      return pid == null ? null : { key: pid.toLowerCase(), send: pid };
    },
    pgKeysSql: async () =>
      `SELECT lower(btrim(pid::text)) AS a, lower(btrim(old_db_id::text)) AS b
       FROM public.patient_info
       WHERE COALESCE(first_name_th, '') <> $1`,
    pgParams: [PLACEHOLDER_FIRST_NAME_TH],
    // pid กับ old_db_id นับเป็นคนเดียวกัน (send = null: ไม่ใช้ตรวจ partial)
    pgUnitsFromRow: (r) =>
      [r[0], r[1]]
        .filter((v) => v != null && v !== "")
        .map((k) => ({ key: k, send: null })),
  },
  examination: examKeyedSpec("examination", "examination"),
  billing: examKeyedSpec("billing", "billing"),
  examination_general: examKeyedSpec("examination-general", "examination_general"),
  ultrasound: examKeyedSpec("ultrasound", "ultrasound"),
  mam: examKeyedSpec("mam", "mammogram"),
  mam_cal: examChildSpec("mam-cal", "mammogram_cal", "Described_Cal_ID"),
  mam_mass: examChildSpec("mam-mass", "mammogram_mass", "Described_Mass_ID"),
  ultrasound_cyst: examChildSpec("ultrasound-cyst", "ultrasound_cyst", "Described_Cyst_ID"),
  ultrasound_mass: examChildSpec("ultrasound-mass", "ultrasound_mass", "Described_Mass_ID"),
  // Accession_ID ซ้ำได้ — post-load ลบ/เขียน accession ทั้งก้อน → เทียบจำนวนแถวต่อ accession
  pacs_sync_info: {
    dir: "pacs-sync-info",
    multiset: true,
    sourceKeysSql: (src) =>
      `SELECT LTRIM(RTRIM(CONVERT(NVARCHAR(256), [Accession_ID]))) AS k FROM ${src} WHERE [Accession_ID] IS NOT NULL`,
    toSourceUnit: (r) => {
      const k = r.k == null ? null : String(r.k).trim();
      return k ? { key: k, send: k } : null;
    },
    pgKeysSql: async () =>
      `SELECT btrim(accession_id::text) AS k FROM public.pacs_sync_info WHERE accession_id IS NOT NULL`,
    toPgUnit: (r) => {
      const k = r[0] == null ? null : String(r[0]).trim();
      return k ? { key: k, send: k } : null;
    },
  },
  // old_db_id = Exam_ID_BiopsyID — นิพจน์เดียวกับ MSSQL_PROCEDURE_BY_OLD_DB_IDS_SELECT
  procedure: {
    dir: "procedure",
    sourceKeysSql: (src) =>
      `SELECT CAST(CAST([Exam_ID] AS NVARCHAR(50)) AS NVARCHAR(50)) + N'_' + CAST(CAST([BiopsyID] AS NVARCHAR(50)) AS NVARCHAR(50)) AS k
       FROM ${src} WHERE [Exam_ID] IS NOT NULL AND [BiopsyID] IS NOT NULL`,
    toSourceUnit: (r) => {
      const k = r.k == null ? null : String(r.k).replace(/^﻿/, "").trim();
      return k ? { key: k, send: k } : null;
    },
    pgKeysSql: async () =>
      `SELECT btrim(old_db_id::text) AS k FROM public."procedure" WHERE old_db_id IS NOT NULL`,
    toPgUnit: (r) => {
      const k = r[0] == null ? null : String(r[0]).trim();
      return k ? { key: k, send: k } : null;
    },
  },
};

/** normalize PID แบบเดียวกับตอน migrate (ตัด BOM + trim) */
function normPid(v) {
  if (v == null) return null;
  const s = String(v).replace(/^﻿/, "").trim();
  return s === "" ? null : s;
}

/** --source-ids คั่นด้วย , ; และ trim ทีละตัว — id ที่มีอักขระพวกนี้ส่งไม่ได้ */
export function isSendableSourceId(id) {
  return id !== "" && !/[,;\s]/.test(id);
}

/**
 * @param {Iterable<{ key: string, send: string }>} sourceUnits
 * @param {Iterable<{ key: string, send: string }>} pgUnits
 * @param {{ multiset?: boolean }} [opts] multiset = key ซ้ำได้ เทียบจำนวนต่อ key
 */
export function computeCatchUpPlan(sourceUnits, pgUnits, opts = {}) {
  const multiset = opts.multiset === true;
  /** @type {Map<string, { n: number, send: string }>} */
  const src = new Map();
  let sourceRows = 0;
  for (const u of sourceUnits) {
    sourceRows++;
    const cur = src.get(u.key);
    if (!cur) src.set(u.key, { n: 1, send: u.send });
    else if (multiset) cur.n++;
  }
  const { pg, pgSends, pgRows } = countPgUnits(pgUnits);

  let missingRows = 0;
  /** @type {Set<string>} */
  const missingSends = new Set();
  for (const [key, { n, send }] of src) {
    const need = multiset ? n : 1;
    const have = pg.get(key) ?? 0;
    if (have < need) {
      missingRows += need - have;
      missingSends.add(send);
    }
  }

  const sends = [];
  const partialSends = [];
  const unsendable = [];
  for (const send of missingSends) {
    if (pgSends.has(send)) partialSends.push(send);
    else if (isSendableSourceId(send)) sends.push(send);
    else unsendable.push(send);
  }
  sends.sort(compareSourceIds);
  partialSends.sort(compareSourceIds);
  unsendable.sort(compareSourceIds);
  return { sourceRows, pgRows, missingRows, sends, partialSends, unsendable };
}

/** นับ key ฝั่ง Postgres + send ที่มีอย่างน้อย 1 แถว (ใช้ตรวจ partial) */
function countPgUnits(pgUnits) {
  /** @type {Map<string, number>} */
  const pg = new Map();
  const pgSends = new Set();
  let pgRows = 0;
  for (const u of pgUnits) {
    pgRows++;
    pg.set(u.key, (pg.get(u.key) ?? 0) + 1);
    if (u.send != null) pgSends.add(u.send);
  }
  return { pg, pgSends, pgRows };
}

/** เลขล้วนเรียงตามค่า อย่างอื่นเรียงตามตัวอักษร */
export function compareSourceIds(a, b) {
  if (a.length !== b.length && /^\d+$/.test(a) && /^\d+$/.test(b)) {
    return a.length - b.length;
  }
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** แบ่ง id เป็นก้อน — แต่ละก้อนไปเป็น argv เดียว (Linux จำกัด ~128KB ต่อ argument) */
export function chunkSourceIds(ids, maxIds, maxChars = 60000) {
  const out = [];
  let cur = [];
  let len = 0;
  for (const id of ids) {
    if (cur.length > 0 && (cur.length >= maxIds || len + id.length + 1 > maxChars)) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(id);
    len += id.length + 1;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** ไฟล์ key ต้นทาง: บรรทัดละ key<TAB>send */
export function formatKeyLine(u) {
  return `${u.key}\t${u.send}\n`;
}

/** @param {string} file */
export async function* readKeyFile(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line === "") continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    yield { key: line.slice(0, tab), send: line.slice(tab + 1) };
  }
}

/** แปลงแถว Postgres (rowMode array) เป็น unit ตาม spec */
export function pgUnitsOf(spec, row) {
  if (spec.pgUnitsFromRow) return spec.pgUnitsFromRow(row);
  const u = spec.toPgUnit(row);
  return u ? [u] : [];
}

/** env สำหรับเรียก migrate ลูก — ตัด npm_* ออก (ไม่งั้น --source-ids ถูกมองว่ารันผ่าน npm แล้ว error เรื่องเครื่องหมายคำพูด) */
export function childEnvWithoutNpm(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^npm_/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}
