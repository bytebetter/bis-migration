import { normPid } from "../../patient-info/js-migrate/patientInfoMapping.mjs";
import { ENSURE_PLACEHOLDER_PATIENT_INFO_ENABLED } from "./placeholderMigrateFlags.mjs";
import {
  ensurePatientInfoPidCiIndexes,
  patientPidMatchSql,
  pidMatchKey,
} from "./patientPidMatch.mjs";

/** ชื่อจริงใน public.patient_info */
export const PLACEHOLDER_FIRST_NAME_TH = "ไม่ทราบชื่อ";

/** แถว patient_info ที่สร้างจาก ensurePlaceholderPatientInfo */
export function isPlaceholderPatientRow(row) {
  return row?.first_name_th === PLACEHOLDER_FIRST_NAME_TH;
}

/**
 * ตาราง migrate ที่ถ้าไม่พบ patient_info ตาม pid จะสร้าง placeholder ก่อนแมป
 * (ไม่นับเป็น patient_not_resolved)
 */
export const TABLES_ENSURE_PLACEHOLDER_PATIENT = [
  "appointment",
  "examination",
  "examination_general",
  "pacs_sync_info",
  "ultrasound",
  "mammogram",
  "mammogram_cal",
  "mammogram_mass",
  "ultrasound_cyst",
  "ultrasound_mass",
];

function clampText255(v) {
  const t = v == null ? "" : String(v).trim();
  if (t === "") return null;
  return t.length <= 255 ? t : t.slice(0, 255);
}

/** last_name_th = "PID {pid}" (จำกัด varchar 255) */
export function placeholderLastNameTh(pid) {
  const p = clampText255(pid) ?? String(pid ?? "");
  const prefix = "PID ";
  const maxPidLen = 255 - prefix.length;
  const body = p.length <= maxPidLen ? p : p.slice(0, maxPidLen);
  return `${prefix}${body}`;
}

/**
 * สร้าง public.patient_info ชั่วคราวสำหรับ pid ที่ยังไม่มี
 * (จับคู่ทั้ง pid และ old_db_id แบบไม่สนตัวพิมพ์ — m1175 กับ M1175 คือคนเดียวกัน)
 * @returns {{ inserted: number }}
 */
export async function ensurePlaceholderPatientInfo(pgClient, rawPids) {
  if (!ENSURE_PLACEHOLDER_PATIENT_INFO_ENABLED) return { inserted: 0 };

  /** key ไม่สนตัวพิมพ์ → PID ตัวแรกที่เจอ (ใช้เป็นค่าใน placeholder) */
  const pidByKey = new Map();
  for (const raw of rawPids ?? []) {
    const p = normPid(raw);
    if (p === "") continue;
    const k = pidMatchKey(p);
    if (!pidByKey.has(k)) pidByKey.set(k, p);
  }
  if (pidByKey.size === 0) return { inserted: 0 };

  await ensurePatientInfoPidCiIndexes(pgClient);
  const { rows: found } = await pgClient.query(
    `
    SELECT DISTINCT u.k
    FROM unnest($1::text[]) AS u(k)
    WHERE EXISTS (
      SELECT 1 FROM public.patient_info pi
      WHERE ${patientPidMatchSql("pi", "u.k")}
    )
    `,
    [[...pidByKey.keys()]],
  );
  const foundSet = new Set(found.map((r) => r.k));
  const missing = [...pidByKey]
    .filter(([k]) => !foundSet.has(k))
    .map(([, p]) => p);
  if (missing.length === 0) return { inserted: 0 };

  const aOld = [];
  const aPid = [];
  const aFn = [];
  const aLn = [];
  for (const p of missing) {
    const np = clampText255(p);
    aOld.push(np);
    aPid.push(np);
    aFn.push(PLACEHOLDER_FIRST_NAME_TH);
    aLn.push(placeholderLastNameTh(p));
  }

  const ins = await pgClient.query(
    `
    INSERT INTO public.patient_info (old_db_id, pid, first_name_th, last_name_th)
    SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
      AS t(old_db_id, pid, first_name_th, last_name_th)
    RETURNING id
    `,
    [aOld, aPid, aFn, aLn],
  );

  await pgClient.query(`
    SELECT setval(
      pg_get_serial_sequence('public.patient_info', 'id'),
      COALESCE((SELECT MAX(id) + 1 FROM public.patient_info), 1),
      false
    )
    WHERE pg_get_serial_sequence('public.patient_info', 'id') IS NOT NULL
  `);

  return { inserted: ins.rowCount ?? ins.rows?.length ?? 0 };
}

/**
 * ดึง pid ไม่ซ้ำจาก staging แล้ว ensure placeholder
 * @param {string} stagingFromClause เช่น migrate_stg.examination_general_mssql
 * @param {string} [pidCol] ชื่อคอลัมน์ pid ใน staging (ค่าเริ่มต้น pid)
 */
export async function ensurePlaceholderPatientInfoFromStaging(
  pgClient,
  stagingFromClause,
  pidCol = "pid",
) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(pidCol)) {
    throw new Error(`invalid pidCol for staging ensure: ${pidCol}`);
  }
  const { rows } = await pgClient.query(
    `
    SELECT DISTINCT NULLIF(btrim(s.${pidCol}::text), '') AS pid
    FROM ${stagingFromClause} s
    WHERE NULLIF(btrim(s.${pidCol}::text), '') IS NOT NULL
    `,
  );
  return ensurePlaceholderPatientInfo(
    pgClient,
    rows.map((r) => r.pid),
  );
}
