import {
  patientPidMatchSql,
  patientPidPreferenceOrderSql,
} from "../../shared/js-migrate/patientPidMatch.mjs";

const INT_RE = /^-?\d+$/;
const STAGING = "migrate_stg.billing_mssql";

/**
 * MSSQL master patient_type.ID → public.payment_type.id (Directus)
 * ไม่ลง billing.patient_type — ใช้เฉพาะ map เป็น payment_type
 */
export const MSSQL_PATIENT_TYPE_TO_PAYMENT_TYPE_ID = {
  1: 1, // ผู้ป่วยนอกเบิกได้จากราชการ → ผู้ป่วยนอก สิทธิเบิกจ่ายตรง กรมบัญชีกลาง
  2: 2, // ผู้ป่วยนอกเบิกได้จากปกติ → ผู้ป่วยนอก สิทธิเบิกหน่วยงานอื่นๆ
  3: 7, // ผู้ป่วยนอกเบิกไม่ได้ → เบิกไม่ได้
  4: 7, // ผู้ป่วยในเบิกไม่ได้ → เบิกไม่ได้
  5: 3, // ผู้ป่วยนอกประกันสังคมศิริราช
  6: 4, // ผู้ป่วยนอกประกันสังคมโรงพยาบาลอื่น
  7: 5, // ผู้ป่วยนอกบัตร 30 บาทศิริราช
  8: 6, // ผู้ป่วยนอกบัตร 30 บาทโรงพยาบาลอื่น
  9: 19, // ผู้ป่วยในเบิกหน่วยงานอื่น
  10: 20, // ผู้ป่วยในประกันสังคมศิริราช
  11: 21, // ผู้ป่วยในประกันสังคมโรงพยาบาลอื่น
  12: 22, // ผู้ป่วยในบัตร 30 บาทศิริราช
  13: 23, // ผู้ป่วยในบัตร 30 บาทโรงพยาบาลอื่น
  14: 18, // ผู้ป่วยในเบิกต้นสังกัด → ผู้ป่วยใน สิทธิเบิกจ่ายตรง กรมบัญชีกลาง
  15: 8, // ผู้ป่วยรายได้น้อยตรวจฟรี
  16: 9, // ผู้ป่วยรายได้น้อยจ่ายบางส่วน
  17: 10, // ผู้มีอุปการะคุณ
  18: 11, // ผู้ทรงศีล
  19: 16, // ผู้ป่วยอื่นๆของศูนย์
  20: 17, // ผู้ป่วยอื่นๆของศิริราช
};

function sqlMapMssqlPatientTypeToPaymentType(
  stagingExpr = "NULLIF(btrim(s.patient_type), '')",
) {
  const whens = Object.entries(MSSQL_PATIENT_TYPE_TO_PAYMENT_TYPE_ID)
    .map(([mssqlId, paymentTypeId]) => `WHEN '${mssqlId}' THEN ${paymentTypeId}`)
    .join("\n      ");
  return `CASE ${stagingExpr}
      ${whens}
      ELSE NULL
    END`;
}

/**
 * billing.care_type จาก public.payment_type.care_type หลัง map payment_type
 * ยกเว้นเบิกไม่ได้ (payment_type 7, care_type null): แยกจาก MSSQL patient_type
 *   3 ผู้ป่วยนอกเบิกไม่ได้ → "1", 4 ผู้ป่วยในเบิกไม่ได้ → "2"
 */
function sqlCareTypeFromMappedPaymentType(
  stagingExpr = "NULLIF(btrim(s.patient_type), '')",
) {
  const paymentTypeIdExpr = sqlMapMssqlPatientTypeToPaymentType(stagingExpr);
  const fromPaymentType = `(
    SELECT NULLIF(btrim(pt.care_type::text), '')
    FROM public.payment_type pt
    WHERE pt.id = (${paymentTypeIdExpr})
  )`;
  return `CASE ${stagingExpr}
      WHEN '3' THEN '1'
      WHEN '4' THEN '2'
      ELSE ${fromPaymentType}
    END`;
}

const INT_RE_STAGING = "^[0-9]+$";
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

function getField(row, key) {
  if (row == null) return undefined;
  if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  const lk = key.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(row, lk)) return row[lk];
  const uk = key.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(row, uk)) return row[uk];
  for (const k of Object.keys(row)) {
    if (k.toLowerCase() === lk) return row[k];
  }
  return undefined;
}

function nullIfTrimEmpty(v) {
  if (v == null) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
}

function toStrictInt(v) {
  const t = nullIfTrimEmpty(v);
  if (t == null || !INT_RE.test(t)) return null;
  return Number.parseInt(t, 10);
}

function toStagingText(v) {
  const t = nullIfTrimEmpty(v);
  return t == null ? "" : t;
}

/** datetime จาก MSSQL ISO / JS Date → timestamp สำหรับ Postgres */
export function normalizeBillingDatetimeToPg(value) {
  if (value == null) return "";
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    const hh = String(value.getUTCHours()).padStart(2, "0");
    const mm = String(value.getUTCMinutes()).padStart(2, "0");
    const ss = String(value.getUTCSeconds()).padStart(2, "0");
    let yyyy = y;
    if (yyyy >= 2400) yyyy -= 543;
    return `${yyyy}-${m}-${d} ${hh}:${mm}:${ss}`;
  }
  const t = nullIfTrimEmpty(value);
  if (t == null) return "";
  const s = String(t).replace("T", " ").replace(/\.\d{3}Z$/i, "").replace(/Z$/i, "");
  if (s.length >= 10 && s[4] === "-") {
    const yearRaw = Number.parseInt(s.slice(0, 4), 10);
    if (Number.isFinite(yearRaw) && yearRaw >= 2400) {
      return `${String(yearRaw - 543).padStart(4, "0")}${s.slice(4)}`;
    }
  }
  return s;
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

let billingTargetColumnsCache = null;
let appointmentTargetColumnsCache = null;

export function resetBillingTargetColumnCache() {
  billingTargetColumnsCache = null;
  appointmentTargetColumnsCache = null;
  billingPostLoadSqlCache = null;
  billingFinanceWorkSqlCache = undefined;
  billingDerivedFillSqlCache = undefined;
}

/** @type {{ mode: string, idMapSql: string | null, deleteSql: string | null, insertSql: string, examMapSql: string, updateAppointmentSql: string | null, fillDerivedSql: string | null, relinkFinanceWorkSql: string | null, createFinanceWorkSql: string | null } | null} */
let billingPostLoadSqlCache = null;

/**
 * finance_work ของบิลจาก DB เก่า — ระบบใหม่ flow สร้าง finance_work คู่กับ billing เสมอ
 * บิลที่ย้ายมาจึงต้องมีด้วย ไม่งั้นหน้าที่อ่านสถานะผ่าน billing.finance_work ไม่เห็นเคสเก่า
 *
 * - status "3" = ชำระเงินแล้ว
 * - location = examination.location ของ exam ที่บิลผูก (exam ย้ายมา = 1 TYR จาก default) ไม่เจอ exam = 1
 * - date_created = วันตรวจ (examination.exam_date) — หน้าการเงินทุกแท็บ/รายงานกรองวันจากฟิลด์นี้ ต้องเป็นวันรับบริการจริง
 *   exam ไม่มีวัน → billing.exam_datetime → appointment.appointment_datetime (แบบที่ฟอร์มการเงินใช้แทนเมื่อ exam_date ว่าง)
 * - ไม่มี queue (DB เก่าไม่มีคิว)
 * - ผูก 2 ทาง: finance_work.billing + billing.finance_work
 */
const FINANCE_WORK_PAID_STATUS = "3";
const FINANCE_WORK_DEFAULT_LOCATION = 1;
const FINANCE_WORK_BACKFILL_BATCH = 20000;
const THAI_TIME_ZONE = "Asia/Bangkok";

/**
 * วันเวลาจาก DB เก่า (เวลาไทยบนนาฬิกา ไม่มี timezone) → timestamptz ที่ชี้เวลาจริงถูกต้อง
 * หน้าการเงินกรอง date_created ด้วยต้นวัน/ท้ายวันตามเวลาไทยของ browser ถ้าเพี้ยน 7 ชม. เคสตรวจช่วงเย็นจะไปตกวันถัดไป
 * @returns {string | null} null = ชนิดคอลัมน์ใช้ไม่ได้
 */
function sqlThaiWallClockToTimestamptz(colExpr, colMeta) {
  const dt = colMeta?.data_type ?? "";
  if (dt === "timestamp with time zone") {
    // ค่าที่ migrate ลง timestamptz (เช่น examination.exam_date) ถูกตีความด้วย TimeZone ของ session ตอน insert
    // แกะกลับเป็นเวลาบนนาฬิกาเดิมก่อน แล้วค่อยตีความเป็นเวลาไทย (session เป็น Asia/Bangkok อยู่แล้ว = ค่าเดิม)
    return `((${colExpr} AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE '${THAI_TIME_ZONE}')`;
  }
  if (dt === "timestamp without time zone" || dt === "date") {
    return `(${colExpr}::timestamp AT TIME ZONE '${THAI_TIME_ZONE}')`;
  }
  return null;
}

/**
 * @typedef {{
 *   tgtSelect: string,
 *   build: (tgtSql: string) => string,
 *   fillDateCreatedSql: string | null,
 * }} BillingFinanceWorkSqlBuilder
 */

/** @type {BillingFinanceWorkSqlBuilder | null | undefined} undefined = ยังไม่ได้เช็ค, null = ปลายทางไม่พร้อม */
let billingFinanceWorkSqlCache = undefined;

/**
 * เตรียมตัวสร้าง SQL "สร้าง finance_work ให้บิลที่ยังไม่มี"
 * @returns {Promise<BillingFinanceWorkSqlBuilder | null>} null = ปลายทางยังไม่มีตาราง/คอลัมน์ที่ต้องใช้
 */
async function getBillingFinanceWorkSqlBuilder(pgClient) {
  if (billingFinanceWorkSqlCache !== undefined) return billingFinanceWorkSqlCache;

  const billingCols = await getCachedBillingTargetColumns(pgClient);
  const fwCols = await existingColumns(pgClient, "finance_work");
  if (
    !billingCols.has("finance_work") ||
    !fwCols.has("billing") ||
    !fwCols.has("status")
  ) {
    billingFinanceWorkSqlCache = null;
    return null;
  }

  const examCols = await existingColumns(pgClient, "examination");
  const aptCols = await getCachedAppointmentTargetColumns(pgClient);
  const { rows: locRows } = await pgClient.query(
    "SELECT to_regclass('public.locations') IS NOT NULL AS ok",
  );
  const hasLocationsTable = locRows[0]?.ok === true;
  const locationRawExpr = examCols.has("location")
    ? `COALESCE(e.location, ${FINANCE_WORK_DEFAULT_LOCATION})`
    : String(FINANCE_WORK_DEFAULT_LOCATION);

  const hasBillingExamDatetime = billingCols.has("exam_datetime");
  const tgtSelect = [
    "b.id AS billing_id",
    "b.exam",
    "b.appointment",
    hasBillingExamDatetime ? "b.exam_datetime" : "NULL::timestamp AS exam_datetime",
  ].join(", ");

  // date_created: exam_date ของ exam → exam_datetime ของบิล → เวลานัด
  const examDateExpr = examCols.has("exam_date")
    ? sqlThaiWallClockToTimestamptz("e.exam_date", examCols.get("exam_date"))
    : null;
  const billingExamDateExpr = hasBillingExamDatetime
    ? sqlThaiWallClockToTimestamptz("t.exam_datetime", billingCols.get("exam_datetime"))
    : null;
  const appointmentDateExpr = aptCols.has("appointment_datetime")
    ? sqlThaiWallClockToTimestamptz("ap.appointment_datetime", aptCols.get("appointment_datetime"))
    : null;
  const dateCandidates = [examDateExpr, billingExamDateExpr, appointmentDateExpr].filter(Boolean);
  const needDateCreated = fwCols.has("date_created") && dateCandidates.length > 0;
  const dateCreatedExpr = needDateCreated
    ? `COALESCE(\n      ${dateCandidates.join(",\n      ")}\n    )`
    : null;
  const dateUsesExam = needDateCreated && examDateExpr != null;
  const dateUsesAppointment = needDateCreated && appointmentDateExpr != null;
  const dateJoins = [
    dateUsesExam ? "LEFT JOIN public.examination e ON e.id = t.exam" : "",
    dateUsesAppointment ? "LEFT JOIN public.appointment ap ON ap.id = t.appointment" : "",
  ]
    .filter(Boolean)
    .join("\n  ");

  const insertCols = ["billing", "status"];
  const selectExprs = ["t.billing_id", `'${FINANCE_WORK_PAID_STATUS}'`];
  if (fwCols.has("exam")) {
    insertCols.push("exam");
    selectExprs.push("t.exam");
  }
  if (fwCols.has("appointment")) {
    insertCols.push("appointment");
    selectExprs.push("t.appointment");
  }
  const needLocation = fwCols.has("location");
  if (needLocation) {
    insertCols.push("location");
    // FK → public.locations: id ที่ไม่มีในตาราง = null แทนที่จะทำทั้ง chunk ล้ม
    selectExprs.push(hasLocationsTable ? "loc.id" : locationRawExpr);
  }
  if (needDateCreated) {
    insertCols.push("date_created");
    selectExprs.push(dateCreatedExpr);
  }
  const needExamJoin = (needLocation && examCols.has("location")) || dateUsesExam;
  const examJoin = needExamJoin
    ? "LEFT JOIN public.examination e ON e.id = t.exam"
    : "";
  const aptJoin = dateUsesAppointment
    ? "LEFT JOIN public.appointment ap ON ap.id = t.appointment"
    : "";
  const locJoin = needLocation && hasLocationsTable
    ? `LEFT JOIN public.locations loc ON loc.id = ${locationRawExpr}`
    : "";

  /**
   * finance_work ที่ migrate สร้างไว้ก่อนหน้า (ตอน date_created ยังว่าง) → เติมเฉพาะแถวที่ยังว่าง
   * เฉพาะบิลที่มี old_exam_id (ย้ายมา) — finance_work ของระบบใหม่ไม่ถูกแตะ; $1 = billing.id ล่าสุดที่ทำแล้ว, $2 = ขนาดชุด
   */
  const fillDateCreatedSql = needDateCreated
    ? `
WITH tgt AS (
  SELECT ${tgtSelect}, b.finance_work
  FROM public.billing AS b
  INNER JOIN public.finance_work fw0 ON fw0.id = b.finance_work
  WHERE b.old_exam_id IS NOT NULL
    AND fw0.date_created IS NULL
    AND b.id > $1
  ORDER BY b.id
  LIMIT $2
),
picked AS (
  SELECT t.finance_work, ${dateCreatedExpr} AS date_created
  FROM tgt t
  ${dateJoins}
),
upd AS (
  UPDATE public.finance_work AS fw
  SET date_created = picked.date_created
  FROM picked
  WHERE fw.id = picked.finance_work
    AND fw.date_created IS NULL
    AND picked.date_created IS NOT NULL
  RETURNING fw.id
)
SELECT
  (SELECT COUNT(*)::int FROM upd) AS updated,
  (SELECT MAX(billing_id)::bigint FROM tgt) AS max_billing_id;
`.trim()
    : null;

  /** tgtSql ต้อง SELECT ${tgtSelect} จาก public.billing AS b — 1 แถวต่อ billing ที่ยังไม่มี finance_work */
  const build = (tgtSql) =>
    `
WITH tgt AS (
${tgtSql}
),
ins AS (
  INSERT INTO public.finance_work (${insertCols.join(", ")})
  SELECT
    ${selectExprs.join(",\n    ")}
  FROM tgt t
  ${examJoin}
  ${aptJoin}
  ${locJoin}
  RETURNING id, billing
),
upd AS (
  UPDATE public.billing AS b
  SET finance_work = ins.id
  FROM ins
  WHERE b.id = ins.billing
  RETURNING b.id
)
SELECT
  (SELECT COUNT(*)::int FROM upd) AS created,
  (SELECT MAX(billing_id)::bigint FROM tgt) AS max_billing_id;
`.trim();

  billingFinanceWorkSqlCache = { tgtSelect, build, fillDateCreatedSql };
  return billingFinanceWorkSqlCache;
}

/** time_slot id ช่วงเย็นพิเศษนอกเวลาราชการ — ตรงกับ AFTER_HOURS_TIME_SLOT_IDS ของหน้าการเงิน */
const AFTER_HOURS_TIME_SLOT_IDS = [25, 26, 27, 28];
const ICS_LOCATION_ID = 3;

/** วันเวลาบนนาฬิกาไทย (timestamp ไม่มี tz) สำหรับดูวันในสัปดาห์ */
function sqlThaiWallClock(colExpr, colMeta) {
  const dt = colMeta?.data_type ?? "";
  if (dt === "timestamp with time zone") return `(${colExpr} AT TIME ZONE '${THAI_TIME_ZONE}')`;
  if (dt === "timestamp without time zone" || dt === "date") return `(${colExpr}::timestamp)`;
  return null;
}

/** @type {{ build: (tgtSql: string) => string, preFilterSql: string } | null | undefined} */
let billingDerivedFillSqlCache = undefined;

/**
 * ฟิลด์ billing ที่ระบบใหม่ให้ฟอร์มการเงินตั้งตอนบันทึก — บิลย้ายมาไม่เคยผ่านฟอร์ม จึงเติมด้วยกติกาเดียวกับฟอร์ม
 * (BIS-Backoffice finance/useFinanceFormLogic.tsx + finance-cost.ts) เติมเฉพาะช่องที่ยังว่าง ไม่ทับค่าที่แก้ในระบบใหม่
 *
 * - total_exam / service_total / last_total ว่าง → total (DB เก่ามียอดเดียว)
 * - payment_method ว่างหรือ "0" → ตาม care_type + payment_type แบบ effect ในฟอร์ม
 *     สิทธิ 7/24: ผู้ป่วยใน "3" นอกนั้น "2" · ผู้ป่วยใน "3" · อื่นๆ ของศูนย์ "2"
 *     ผู้ป่วยนอก: สิทธิ 1/2 "1", สิทธิ 3–6 "3" · ที่เหลือ "2" (ค่า default ของฟอร์ม)
 * - is_invoice_requested ว่าง → payment_method = "3"
 * - is_overtime ว่าง → นัด time_slot 25–28 หรือวันเสาร์/อาทิตย์ (ไม่ใช่ ICS) — แบบที่ฟอร์มติ๊กให้เองตอนเปิด
 * - patient_category ว่าง → care_type "3" = "3" (อื่นๆ ของศูนย์), นอกนั้นตาม appointment.is_new_patient (1 ใหม่ / 0,2 เก่า)
 *
 * @returns {Promise<{ build: (tgtSql: string) => string, preFilterSql: string } | null>} null = ไม่มีฟิลด์ให้เติม
 */
async function getBillingDerivedFillSqlBuilder(pgClient) {
  if (billingDerivedFillSqlCache !== undefined) return billingDerivedFillSqlCache;

  const cols = await getCachedBillingTargetColumns(pgClient);
  const aptCols = await getCachedAppointmentTargetColumns(pgClient);
  const examCols = await existingColumns(pgClient, "examination");

  const careExpr = cols.has("care_type")
    ? "NULLIF(btrim(b.care_type::text), '')"
    : "NULL::text";
  const ptExpr = cols.has("payment_type")
    ? "NULLIF(btrim(b.payment_type::text), '')"
    : "NULL::text";
  const pmCurrentExpr = "NULLIF(NULLIF(btrim(b.payment_method::text), ''), '0')";
  const pmDerivedExpr = `CASE
      WHEN ${ptExpr} IN ('7', '24') THEN CASE WHEN ${careExpr} = '2' THEN '3' ELSE '2' END
      WHEN ${careExpr} = '2' THEN '3'
      WHEN ${careExpr} = '3' THEN '2'
      WHEN ${careExpr} = '1' AND ${ptExpr} IN ('1', '2') THEN '1'
      WHEN ${careExpr} = '1' AND ${ptExpr} IN ('3', '4', '5', '6') THEN '3'
      ELSE '2'
    END`;
  const hasPaymentMethod = cols.has("payment_method");
  const pmResolvedExpr = hasPaymentMethod
    ? `COALESCE(${pmCurrentExpr}, ${pmDerivedExpr})`
    : pmDerivedExpr;

  const hasAptJoin = cols.has("appointment");
  const slotExpr = hasAptJoin && aptCols.has("time_slot")
    ? `COALESCE(ap.time_slot IN (${AFTER_HOURS_TIME_SLOT_IDS.join(", ")}), false)`
    : null;
  const aptClock = hasAptJoin && aptCols.has("appointment_datetime")
    ? sqlThaiWallClock("ap.appointment_datetime", aptCols.get("appointment_datetime"))
    : null;
  const weekendExpr = aptClock
    ? `COALESCE(EXTRACT(ISODOW FROM ${aptClock}) IN (6, 7), false)`
    : null;
  const examLocationJoin = cols.has("exam") && examCols.has("location");
  const isIcsExpr = examLocationJoin
    ? `COALESCE(e.location, ${FINANCE_WORK_DEFAULT_LOCATION}) = ${ICS_LOCATION_ID}`
    : "false";
  const overtimeExpr = slotExpr || weekendExpr
    ? `CASE
      WHEN ${isIcsExpr} THEN false
      WHEN ap.id IS NULL THEN NULL
      ELSE ${[slotExpr, weekendExpr].filter(Boolean).join(" OR ")}
    END`
    : null;
  const newPatientExpr = hasAptJoin && aptCols.has("is_new_patient")
    ? `WHEN ap.is_new_patient = 1 THEN '1'
      WHEN ap.is_new_patient IN (0, 2) THEN '2'`
    : "";
  const patientCategoryExpr = `CASE
      WHEN ${careExpr} = '3' THEN '3'
      ${newPatientExpr}
      ELSE NULL
    END`;

  /** [คอลัมน์, ค่าที่เติม (อ้าง p.*), เงื่อนไขว่าต้องเติม (อ้าง b.* + p.*), เงื่อนไขกรองล่วงหน้า (อ้าง b.* เท่านั้น)] */
  const fields = [];
  const pickExprs = [];
  for (const name of ["total_exam", "service_total", "last_total"]) {
    if (!cols.has(name) || !cols.has("total")) continue;
    fields.push([name, `COALESCE(b.${name}, b.total)`, `(b.${name} IS NULL AND b.total IS NOT NULL)`, `(b.${name} IS NULL AND b.total IS NOT NULL)`]);
  }
  if (hasPaymentMethod) {
    fields.push(["payment_method", `COALESCE(${pmCurrentExpr}, p.payment_method)`, `(${pmCurrentExpr} IS NULL)`, `(${pmCurrentExpr} IS NULL)`]);
  }
  if (cols.has("is_invoice_requested")) {
    fields.push(["is_invoice_requested", "COALESCE(b.is_invoice_requested, p.is_invoice_requested)", "(b.is_invoice_requested IS NULL)", "(b.is_invoice_requested IS NULL)"]);
  }
  pickExprs.push(`${pmResolvedExpr} AS payment_method`);
  pickExprs.push(`(${pmResolvedExpr}) = '3' AS is_invoice_requested`);
  if (cols.has("is_overtime") && overtimeExpr) {
    pickExprs.push(`${overtimeExpr} AS is_overtime`);
    fields.push(["is_overtime", "COALESCE(b.is_overtime, p.is_overtime)", "(b.is_overtime IS NULL AND p.is_overtime IS NOT NULL)", "(b.is_overtime IS NULL)"]);
  }
  if (cols.has("patient_category")) {
    pickExprs.push(`${patientCategoryExpr} AS patient_category`);
    fields.push([
      "patient_category",
      "COALESCE(NULLIF(btrim(b.patient_category::text), ''), p.patient_category)",
      "(NULLIF(btrim(b.patient_category::text), '') IS NULL AND p.patient_category IS NOT NULL)",
      "(NULLIF(btrim(b.patient_category::text), '') IS NULL)",
    ]);
  }
  if (fields.length === 0) {
    billingDerivedFillSqlCache = null;
    return null;
  }

  const joins = [
    hasAptJoin ? "LEFT JOIN public.appointment ap ON ap.id = b.appointment" : "",
    examLocationJoin ? "LEFT JOIN public.examination e ON e.id = b.exam" : "",
  ].filter(Boolean).join("\n  ");

  /** tgtSql คืน billing_id — บิลที่จะเติม */
  const build = (tgtSql) =>
    `
WITH tgt AS (
${tgtSql}
),
picked AS (
  SELECT
    b.id,
    ${pickExprs.join(",\n    ")}
  FROM tgt t
  INNER JOIN public.billing AS b ON b.id = t.billing_id
  ${joins}
),
upd AS (
  UPDATE public.billing AS b
  SET
    ${fields.map(([name, value]) => `${name} = ${value}`).join(",\n    ")}
  FROM picked AS p
  WHERE b.id = p.id
    AND (
      ${fields.map(([, , need]) => need).join("\n      OR ")}
    )
  RETURNING b.id
)
SELECT
  (SELECT COUNT(*)::int FROM upd) AS updated,
  (SELECT MAX(billing_id)::bigint FROM tgt) AS max_billing_id;
`.trim();

  billingDerivedFillSqlCache = {
    build,
    preFilterSql: `(${fields.map(([, , , pre]) => pre).join(" OR ")})`,
  };
  return billingDerivedFillSqlCache;
}

const BILLING_DATE_STAGING_COLS = new Set(["exam_date", "schedule_date"]);

async function getCachedBillingTargetColumns(pgClient) {
  if (billingTargetColumnsCache) return billingTargetColumnsCache;
  billingTargetColumnsCache = await existingColumns(pgClient, "billing");
  return billingTargetColumnsCache;
}

async function getCachedAppointmentTargetColumns(pgClient) {
  if (appointmentTargetColumnsCache) return appointmentTargetColumnsCache;
  appointmentTargetColumnsCache = await existingColumns(pgClient, "appointment");
  return appointmentTargetColumnsCache;
}

/** appointment.care_type เป็น integer; billing ใช้ varchar "1"/"2"/"3" */
function sqlAppointmentCareTypeFromStaging(stagingExpr, careColMeta) {
  const raw = sqlCareTypeFromMappedPaymentType(stagingExpr);
  if (
    careColMeta &&
    (careColMeta.data_type === "integer" ||
      careColMeta.data_type === "smallint" ||
      careColMeta.data_type === "bigint")
  ) {
    return `CASE
      WHEN (${raw}) IS NULL OR btrim((${raw})::text) = '' THEN NULL
      WHEN btrim((${raw})::text) ~ '^[0-9]+$' THEN btrim((${raw})::text)::integer
      ELSE NULL
    END`;
  }
  return raw;
}

function toSqlValueExpr(baseExpr, colMeta) {
  const dt = colMeta.data_type;
  const udt = colMeta.udt_name;
  if (dt === "integer" || dt === "smallint" || dt === "bigint") {
    return `CASE
      WHEN ${baseExpr} IS NULL OR btrim(${baseExpr}::text) = '' THEN NULL
      WHEN btrim(${baseExpr}::text) ~ '^-?[0-9]+$' THEN btrim(${baseExpr}::text)::bigint
      ELSE NULL
    END`;
  }
  if (dt === "numeric" || dt === "double precision" || dt === "real") {
    return `CASE
      WHEN ${baseExpr} IS NULL OR btrim(${baseExpr}::text) = '' THEN NULL
      WHEN btrim(${baseExpr}::text) ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN btrim(${baseExpr}::text)::numeric
      ELSE NULL
    END`;
  }
  if (dt.includes("timestamp")) {
    return `CASE
      WHEN ${baseExpr} IS NULL OR btrim(${baseExpr}::text) = '' THEN NULL
      ELSE btrim(${baseExpr}::text)::timestamp
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
  if (dt === "text") {
    return `NULLIF(btrim(${baseExpr}::text), '')`;
  }
  if (udt && udt.startsWith("_")) return null;
  return `NULLIF(btrim(${baseExpr}::text), '')`;
}

const SOURCE_FIELD_BY_TARGET = {
  old_exam_id: "exam_id",
  old_pid: "pid",
  exam_datetime: "exam_date",
  is_in_patient: "is_in_patient",
  can_claim_expense: "can_claim_expense",
  hn: "hnno",
  an: "an",
  room: "room",
  building: "building",
  code_no: "codeno",
  note: "note",
  total: "total",
  // DB เก่ามียอดเดียว (Total) — สเปกการเงิน: ใส่ทั้ง total_exam และ service_total (หน้าจอ/รายงานอ่าน service_total ก่อน)
  // last_total ระบบเขียนค่าเดียวกับ total ตอนบันทึก
  total_exam: "total",
  service_total: "total",
  last_total: "total",
  receipt: "receipt",
  receipt_no: "receipt_no",
  a: "a",
  a_price: "a_price",
  b: "b",
  b_price: "b_price",
  c: "c",
  c_price: "c_price",
  d: "d",
  d_price: "d_price",
  e: "e",
  e_price: "e_price",
  f: "f",
  f_price: "f_price",
  g: "g",
  g_price: "g_price",
  h: "h",
  h_price: "h_price",
  i: "i",
  i_price: "i_price",
  j: "j",
  j_price: "j_price",
  k: "k",
  k_price: "k_price",
  l: "l",
  l_price: "l_price",
  m: "m",
  m_price: "m_price",
  n: "n",
  n_price: "n_price",
  o: "o",
  o_price: "o_price",
  p: "p",
  p_price: "p_price",
  q: "q",
  q_price: "q_price",
  r: "r",
  r_price: "r_price",
  s: "s",
  s_price: "s_price",
  t: "t",
  t_price: "t_price",
  u: "u",
  u_price: "u_price",
  mammogram_tec1: "mammogram_tec1",
  mammogram_tec2: "mammogram_tec2",
  ultrasound_tec1: "ultrasound_tec1",
  ultrasound_tec2: "ultrasound_tec2",
  ultrasound_tec3: "ultrasound_tec3",
  ultrasound_tec4: "ultrasound_tec4",
  ultrasound_tec5: "ultrasound_tec5",
  ultrasound_tec6: "ultrasound_tec6",
  stereo_biop_position: "stereo_biop_position",
  us_guided_bx_position: "us_guided_bx_position",
  aspiration_position: "aspiration_position",
  ductogram_fim: "ductogram_film",
  copy_film_film: "copy_film_film",
  cash: "cash",
  appointment_datetime: "schedule_date",
  is_foreigner: "foreigner",
  is_out_patient: "opd",
};

/** insert-only: ไม่ดึงแถวที่มี old_exam_id ใน Postgres แล้ว (แบบ examination) */
export async function filterBillingFetchRowsInsertOnly(pgClient, rows) {
  const cand = Array.from(
    new Set(
      rows
        .map((r) => {
          const t = String(getField(r, "exam_id") ?? "").trim();
          return INT_RE.test(t) ? t : null;
        })
        .filter((id) => id != null),
    ),
  );
  if (cand.length === 0) return [];
  const { rows: existRows } = await pgClient.query(
    `SELECT old_exam_id::text AS eid FROM public.billing WHERE old_exam_id::text = ANY($1::text[])`,
    [cand],
  );
  const have = new Set(existRows.map((r) => String(r.eid)));
  return rows.filter((r) => {
    const id = String(getField(r, "exam_id") ?? "").trim();
    if (!INT_RE.test(id)) return true;
    return !have.has(id);
  });
}

/**
 * สร้าง DELETE/INSERT ครั้งเดียวต่อ migration run (ไม่ introspect ทุก chunk)
 * @param {"overwrite" | "insert-only"} migrateRowMode
 */
export async function prepareBillingPostLoad(
  pgClient,
  migrateRowMode = "overwrite",
) {
  const mode = migrateRowMode === "insert-only" ? "insert-only" : "overwrite";
  const keepExistingId = mode !== "insert-only";
  if (billingPostLoadSqlCache?.mode === mode) return billingPostLoadSqlCache;

  const cols = await getCachedBillingTargetColumns(pgClient);
  if (!cols.has("old_exam_id")) {
    throw new Error('target public.billing must have column "old_exam_id"');
  }

  const oldExamMeta = cols.get("old_exam_id");
  const oldExamIsInt =
    oldExamMeta &&
    (oldExamMeta.data_type === "integer" ||
      oldExamMeta.data_type === "smallint" ||
      oldExamMeta.data_type === "bigint");
  const stgExamJoin = oldExamIsInt
    ? "b.old_exam_id = NULLIF(btrim(s.exam_id), '')::int"
    : "b.old_exam_id::text = NULLIF(btrim(s.exam_id), '')";

  const financeWorkBuilder = await getBillingFinanceWorkSqlBuilder(pgClient);
  // overwrite: DELETE billing ทำให้ finance_work.billing โดน SET NULL — เก็บ id finance_work เดิมไว้ใส่คืน ไม่สร้างซ้ำ
  const keepFinanceWork = keepExistingId && financeWorkBuilder != null;

  const deleteSql =
    mode === "insert-only"
      ? null
      : `
DELETE FROM public.billing AS b
USING ${STAGING} AS s
WHERE ${stgExamJoin}
  AND NULLIF(btrim(s.exam_id), '') ~ '${INT_RE_STAGING}';
`.trim();

  const idMapSql =
    mode === "insert-only"
      ? null
      : `
CREATE TEMP TABLE IF NOT EXISTS billing_keep_id (
  old_exam_id TEXT PRIMARY KEY,
  id BIGINT NOT NULL,
  finance_work BIGINT
) ON COMMIT PRESERVE ROWS;
TRUNCATE billing_keep_id;
INSERT INTO billing_keep_id (old_exam_id, id, finance_work)
SELECT b.old_exam_id::text, b.id::bigint, ${keepFinanceWork ? "b.finance_work::bigint" : "NULL"}
FROM public.billing AS b
INNER JOIN ${STAGING} AS s
  ON ${stgExamJoin}
WHERE NULLIF(btrim(s.exam_id), '') ~ '${INT_RE_STAGING}';
`.trim();

  const insertOnlyGuard =
    mode === "insert-only"
      ? `
  AND NOT EXISTS (
    SELECT 1 FROM public.billing b_existing
    WHERE ${oldExamIsInt ? "b_existing.old_exam_id = NULLIF(btrim(s.exam_id), '')::int" : "b_existing.old_exam_id::text = NULLIF(btrim(s.exam_id), '')"}
  )`
      : "";

  const insertColumns = [];
  const selectExprs = [];
  for (const [name, meta] of cols.entries()) {
    let expr = null;
    if (name === "id") {
      if (keepExistingId) {
        expr = `COALESCE(
        id_keep.id,
        nextval(pg_get_serial_sequence('public.billing', 'id'))
      )`;
      } else {
        expr = "nextval(pg_get_serial_sequence('public.billing', 'id'))";
      }
    } else if (name === "finance_work") {
      if (keepFinanceWork) expr = "id_keep.finance_work";
    } else if (name === "exam") expr = "em.exam_id";
    else if (name === "patient") expr = "p.id";
    else if (name === "appointment") expr = "em.appointment";
    else if (name === "payment_type") {
      expr = sqlMapMssqlPatientTypeToPaymentType();
    } else if (name === "care_type") {
      expr = sqlCareTypeFromMappedPaymentType();
    } else if (SOURCE_FIELD_BY_TARGET[name]) {
      const raw = `NULLIF(btrim(s.${SOURCE_FIELD_BY_TARGET[name]}), '')`;
      expr = toSqlValueExpr(raw, meta);
    }
    if (expr) {
      insertColumns.push(name);
      selectExprs.push(expr);
    }
  }

  if (insertColumns.length === 0) {
    throw new Error("no compatible columns found on public.billing");
  }

  const insertSql = `
INSERT INTO public.billing (${insertColumns.join(", ")})
SELECT
  ${selectExprs.join(",\n  ")}
FROM ${STAGING} s
LEFT JOIN LATERAL (
  SELECT em.exam_id, em.appointment
  FROM migrate_stg.billing_exam_map em
  WHERE em.old_exam_id = NULLIF(btrim(s.exam_id), '')
  ORDER BY em.exam_id
  LIMIT 1
) em ON TRUE
LEFT JOIN LATERAL (
  SELECT p.id
  FROM public.patient_info p
  WHERE ${patientPidMatchSql("p", "NULLIF(btrim(s.pid), '')", { includeOldDbId: false })}
  ORDER BY ${patientPidPreferenceOrderSql("p", "NULLIF(btrim(s.pid), '')")}
  LIMIT 1
) p ON TRUE
${keepExistingId ? "LEFT JOIN billing_keep_id id_keep\n  ON id_keep.old_exam_id = NULLIF(btrim(s.exam_id), '')" : ""}
WHERE NULLIF(btrim(s.exam_id), '') ~ '${INT_RE_STAGING}'${insertOnlyGuard};
`.trim();

  const examMapSql = `
TRUNCATE migrate_stg.billing_exam_map;
INSERT INTO migrate_stg.billing_exam_map (old_exam_id, exam_id, appointment)
SELECT e.old_exam_id, e.id, e.appointment
FROM public.examination e
INNER JOIN ${STAGING} s
  ON e.old_exam_id = NULLIF(btrim(s.exam_id), '')
WHERE NULLIF(btrim(s.exam_id), '') ~ '${INT_RE_STAGING}';
`.trim();

  const aptCols = await getCachedAppointmentTargetColumns(pgClient);
  const aptHasPayment = aptCols.has("payment_type");
  const aptHasCare = aptCols.has("care_type");
  let updateAppointmentSql = null;
  if (aptHasPayment || aptHasCare) {
    const pickSelect = [];
    if (aptHasPayment) {
      pickSelect.push(
        `${sqlMapMssqlPatientTypeToPaymentType()} AS payment_type`,
      );
    }
    if (aptHasCare) {
      pickSelect.push(
        `${sqlAppointmentCareTypeFromStaging(
          "NULLIF(btrim(s.patient_type), '')",
          aptCols.get("care_type"),
        )} AS care_type`,
      );
    }
    const setClauses = [];
    if (aptHasPayment) setClauses.push("payment_type = picked.payment_type");
    if (aptHasCare) setClauses.push("care_type = picked.care_type");

    updateAppointmentSql = `
UPDATE public.appointment AS a
SET
  ${setClauses.join(",\n  ")}
FROM (
  SELECT DISTINCT ON (em.appointment)
    em.appointment AS appointment_id,
    ${pickSelect.join(",\n    ")}
  FROM ${STAGING} s
  INNER JOIN migrate_stg.billing_exam_map em
    ON em.old_exam_id = NULLIF(btrim(s.exam_id), '')
  WHERE em.appointment IS NOT NULL
    AND NULLIF(btrim(s.exam_id), '') ~ '${INT_RE_STAGING}'
  ORDER BY
    em.appointment,
    NULLIF(btrim(s.exam_id), '')::bigint DESC NULLS LAST,
    CASE
      WHEN NULLIF(btrim(s.exam_date), '') IS NULL OR btrim(s.exam_date) = '' THEN NULL
      ELSE btrim(s.exam_date)::timestamp
    END DESC NULLS LAST
) AS picked
WHERE a.id = picked.appointment_id;
`.trim();
  }

  // overwrite: ใส่ billing.finance_work คืนแล้ว แต่ฝั่ง finance_work.billing ถูก SET NULL ตอน DELETE → ผูกกลับ
  const relinkFinanceWorkSql = keepFinanceWork
    ? `
UPDATE public.finance_work AS fw
SET billing = b.id
FROM public.billing AS b
INNER JOIN ${STAGING} AS s
  ON ${stgExamJoin}
WHERE fw.id = b.finance_work
  AND fw.billing IS DISTINCT FROM b.id
  AND NULLIF(btrim(s.exam_id), '') ~ '${INT_RE_STAGING}';
`.trim()
    : null;

  const createFinanceWorkSql = financeWorkBuilder
    ? financeWorkBuilder.build(`
  SELECT ${financeWorkBuilder.tgtSelect}
  FROM public.billing AS b
  INNER JOIN ${STAGING} AS s
    ON ${stgExamJoin}
  WHERE b.finance_work IS NULL
    AND NULLIF(btrim(s.exam_id), '') ~ '${INT_RE_STAGING}'`)
    : null;

  const derivedFillBuilder = await getBillingDerivedFillSqlBuilder(pgClient);
  const fillDerivedSql = derivedFillBuilder
    ? derivedFillBuilder.build(`
  SELECT b.id AS billing_id
  FROM public.billing AS b
  INNER JOIN ${STAGING} AS s
    ON ${stgExamJoin}
  WHERE NULLIF(btrim(s.exam_id), '') ~ '${INT_RE_STAGING}'
    AND ${derivedFillBuilder.preFilterSql}`)
    : null;

  billingPostLoadSqlCache = {
    mode,
    idMapSql,
    deleteSql,
    insertSql,
    examMapSql,
    updateAppointmentSql,
    fillDerivedSql,
    relinkFinanceWorkSql,
    createFinanceWorkSql,
  };
  return billingPostLoadSqlCache;
}

/**
 * ท้าย job: สร้าง finance_work ให้บิลที่ย้ายมาก่อนหน้า (ตอนยังไม่สร้างคู่กัน) — เฉพาะแถวที่มี old_exam_id
 * บิลระบบใหม่ไม่มี old_exam_id และ flow สร้าง finance_work ให้อยู่แล้ว จึงไม่ถูกแตะ
 * ทำเป็นชุดละ FINANCE_WORK_BACKFILL_BATCH แถว commit ทีละชุด — ล้มกลางทาง รอบหน้าทำต่อจากที่เหลือเอง
 * @returns {Promise<number | null>} จำนวน finance_work ที่สร้าง; null = ปลายทางยังไม่มีตาราง/คอลัมน์ที่ต้องใช้
 */
export async function backfillBillingFinanceWork(pgClient) {
  const builder = await getBillingFinanceWorkSqlBuilder(pgClient);
  if (!builder) return null;
  const sqlText = builder.build(`
  SELECT ${builder.tgtSelect}
  FROM public.billing AS b
  WHERE b.finance_work IS NULL
    AND b.old_exam_id IS NOT NULL
    AND b.id > $1
  ORDER BY b.id
  LIMIT $2`);
  let afterId = 0;
  let created = 0;
  while (true) {
    const { rows } = await pgClient.query(sqlText, [
      afterId,
      FINANCE_WORK_BACKFILL_BATCH,
    ]);
    const n = Number(rows[0]?.created ?? 0);
    const maxId = rows[0]?.max_billing_id;
    if (maxId == null) break;
    created += n;
    afterId = Number(maxId);
  }
  return created;
}

/**
 * ท้าย job: บิลที่ย้ายมาก่อนหน้า (ก่อนมีการเติมฟิลด์ตามฟอร์มการเงิน) → เติมช่องที่ยังว่าง
 * ดูกติกาที่ getBillingDerivedFillSqlBuilder; ชุดละ FINANCE_WORK_BACKFILL_BATCH แถว commit ทีละชุด
 * @returns {Promise<number | null>} จำนวนบิลที่เติม; null = ปลายทางไม่มีฟิลด์ให้เติม
 */
export async function backfillBillingDerivedFields(pgClient) {
  const builder = await getBillingDerivedFillSqlBuilder(pgClient);
  if (!builder) return null;
  const sqlText = builder.build(`
  SELECT b.id AS billing_id
  FROM public.billing AS b
  WHERE b.old_exam_id IS NOT NULL
    AND b.id > $1
    AND ${builder.preFilterSql}
  ORDER BY b.id
  LIMIT $2`);
  let afterId = 0;
  let updated = 0;
  while (true) {
    const { rows } = await pgClient.query(sqlText, [
      afterId,
      FINANCE_WORK_BACKFILL_BATCH,
    ]);
    const maxId = rows[0]?.max_billing_id;
    if (maxId == null) break;
    updated += Number(rows[0]?.updated ?? 0);
    afterId = Number(maxId);
  }
  return updated;
}

/**
 * ท้าย job: finance_work ของบิลที่ย้ายมาแต่ date_created ยังว่าง (สร้างก่อนเริ่มใส่วันตรวจ) → เติมวันตรวจ
 * ไม่ทับค่าที่มีอยู่แล้ว; ชุดละ FINANCE_WORK_BACKFILL_BATCH แถว commit ทีละชุด
 * @returns {Promise<number | null>} จำนวนที่เติม; null = ปลายทางยังไม่มีคอลัมน์ที่ต้องใช้
 */
export async function backfillBillingFinanceWorkDateCreated(pgClient) {
  const builder = await getBillingFinanceWorkSqlBuilder(pgClient);
  if (!builder?.fillDateCreatedSql) return null;
  let afterId = 0;
  let updated = 0;
  while (true) {
    const { rows } = await pgClient.query(builder.fillDateCreatedSql, [
      afterId,
      FINANCE_WORK_BACKFILL_BATCH,
    ]);
    const maxId = rows[0]?.max_billing_id;
    if (maxId == null) break;
    updated += Number(rows[0]?.updated ?? 0);
    afterId = Number(maxId);
  }
  return updated;
}

/** ตารางว่าง → id ถัดไปเริ่มที่ 1 (แบบ appointment) */
export async function resetBillingIdSequenceIfEmpty(pgClient) {
  const cols = await getCachedBillingTargetColumns(pgClient);
  if (!cols.has("id")) return;
  await pgClient.query(`
    WITH cnt AS (SELECT COUNT(*)::bigint AS c FROM public.billing)
    SELECT setval(
      pg_get_serial_sequence('public.billing', 'id'),
      1,
      false
    )
    FROM cnt
    WHERE cnt.c = 0
      AND pg_get_serial_sequence('public.billing', 'id') IS NOT NULL;
  `);
}

export async function syncBillingIdSequenceOnce(pgClient) {
  const cols = await getCachedBillingTargetColumns(pgClient);
  if (!cols.has("id")) return;
  await pgClient.query(`
    SELECT setval(
      pg_get_serial_sequence('public.billing', 'id'),
      COALESCE((SELECT MAX(id) + 1 FROM public.billing), 1),
      false
    )
    WHERE pg_get_serial_sequence('public.billing', 'id') IS NOT NULL;
  `);
}

/** @returns {Promise<number>} */
export async function countBillingTargetRows(pgClient) {
  const r = await pgClient.query("SELECT COUNT(*)::bigint AS c FROM public.billing");
  return Number(r.rows[0]?.c ?? 0);
}

/**
 * @returns {{ mapMs: number, deleteMs: number, insertMs: number, updateAppointmentMs: number, financeWorkMs: number, financeWorkCreated: number, postgresMs: number }}
 */
export async function runBillingChunkPostLoad(
  pgClient,
  migrateRowMode = "overwrite",
) {
  const postgresStartedAt = Date.now();
  const {
    idMapSql,
    deleteSql,
    insertSql,
    examMapSql,
    updateAppointmentSql,
    fillDerivedSql,
    relinkFinanceWorkSql,
    createFinanceWorkSql,
  } = await prepareBillingPostLoad(pgClient, migrateRowMode);

  const mapStartedAt = Date.now();
  await pgClient.query(examMapSql);
  if (idMapSql) await pgClient.query(idMapSql);
  const mapMs = Date.now() - mapStartedAt;

  const deleteStartedAt = Date.now();
  if (deleteSql) await pgClient.query(deleteSql);
  const deleteMs = Date.now() - deleteStartedAt;

  const insertStartedAt = Date.now();
  await pgClient.query(insertSql);
  const insertMs = Date.now() - insertStartedAt;

  const updateAppointmentStartedAt = Date.now();
  if (updateAppointmentSql) await pgClient.query(updateAppointmentSql);
  // ฟิลด์ที่ฟอร์มการเงินตั้งให้ (payment_method, is_overtime ฯลฯ) — บิลย้ายมาไม่ผ่านฟอร์ม
  if (fillDerivedSql) await pgClient.query(fillDerivedSql);
  const updateAppointmentMs = Date.now() - updateAppointmentStartedAt;

  const financeWorkStartedAt = Date.now();
  let financeWorkCreated = 0;
  if (relinkFinanceWorkSql) await pgClient.query(relinkFinanceWorkSql);
  if (createFinanceWorkSql) {
    const { rows } = await pgClient.query(createFinanceWorkSql);
    financeWorkCreated = Number(rows[0]?.created ?? 0);
  }
  const financeWorkMs = Date.now() - financeWorkStartedAt;

  return {
    mapMs,
    deleteMs,
    insertMs,
    updateAppointmentMs,
    financeWorkMs,
    financeWorkCreated,
    postgresMs: Date.now() - postgresStartedAt,
  };
}

/** โหลด staging แบบเบา (ไม่ normalize ทุกฟิลด์ใน JS แบบเดิม) */
export function mssqlRowValidForStaging(raw) {
  const eid = getField(raw, "exam_id") ?? getField(raw, "Exam_ID");
  const t = eid == null ? "" : String(eid).trim();
  return t !== "" && INT_RE.test(t);
}

export function stagingCellFromMssql(raw, col) {
  if (BILLING_DATE_STAGING_COLS.has(col)) {
    return (
      normalizeBillingDatetimeToPg(getField(raw, col)) ||
      normalizeBillingDatetimeToPg(getField(raw, col === "exam_date" ? "Exam_Date" : "ScheduleDate")) ||
      ""
    );
  }
  const v = getField(raw, col);
  if (v == null) return "";
  if (v instanceof Date) return normalizeBillingDatetimeToPg(v) || "";
  const t = String(v).trim();
  return t;
}

export function normalizeMssqlRow(raw) {
  const examId = toStrictInt(getField(raw, "exam_id") ?? getField(raw, "Exam_ID"));
  if (examId == null) return null;

  const text = (k) => toStagingText(getField(raw, k));
  const num = (k) => {
    const t = nullIfTrimEmpty(getField(raw, k));
    if (t == null) return "";
    return NUMERIC_RE.test(t) || INT_RE.test(t) ? t : "";
  };

  return {
    exam_id: String(examId),
    exam_date: normalizeBillingDatetimeToPg(
      getField(raw, "exam_date") ?? getField(raw, "Exam_Date"),
    ),
    pid: text("pid") || text("PID"),
    is_in_patient: text("is_in_patient") || text("IsInPatient"),
    can_claim_expense: text("can_claim_expense") || text("CanClaimExpense"),
    hnno: text("hnno") || text("HNNo"),
    an: text("an") || text("AN"),
    room: text("room") || text("Room"),
    building: text("building") || text("Building"),
    codeno: text("codeno") || text("CodeNo"),
    note: text("note") || text("Note"),
    patient_type: text("patient_type") || text("Patient_Type"),
    total: num("total") || num("Total"),
    receipt: num("receipt") || num("Receipt"),
    receipt_no: text("receipt_no") || text("Receipt_No"),
    a: text("a") || text("A"),
    a_price: num("a_price") || num("A_Price"),
    b: text("b") || text("B"),
    b_price: num("b_price") || num("B_Price"),
    c: text("c") || text("C"),
    c_price: num("c_price") || num("C_Price"),
    d: text("d") || text("D"),
    d_price: num("d_price") || num("D_Price"),
    e: text("e") || text("E"),
    e_price: num("e_price") || num("E_Price"),
    f: text("f") || text("F"),
    f_price: num("f_price") || num("F_Price"),
    g: text("g") || text("G"),
    g_price: num("g_price") || num("G_Price"),
    h: text("h") || text("H"),
    h_price: num("h_price") || num("H_Price"),
    i: text("i") || text("I"),
    i_price: num("i_price") || num("I_Price"),
    j: text("j") || text("J"),
    j_price: num("j_price") || num("J_Price"),
    k: text("k") || text("K"),
    k_price: num("k_price") || num("K_Price"),
    l: text("l") || text("L"),
    l_price: num("l_price") || num("L_Price"),
    m: text("m") || text("M"),
    m_price: num("m_price") || num("M_Price"),
    n: text("n") || text("N"),
    n_price: num("n_price") || num("N_Price"),
    o: text("o") || text("O"),
    o_price: num("o_price") || num("O_Price"),
    p: text("p") || text("P"),
    p_price: num("p_price") || num("P_Price"),
    q: text("q") || text("Q"),
    q_price: num("q_price") || num("Q_Price"),
    r: text("r") || text("R"),
    r_price: num("r_price") || num("R_Price"),
    s: text("s") || text("S"),
    s_price: num("s_price") || num("S_Price"),
    t: text("t") || text("T"),
    t_price: num("t_price") || num("T_Price"),
    u: text("u") || text("U"),
    u_price: num("u_price") || num("U_Price"),
    mammogram_tec1: text("mammogram_tec1"),
    mammogram_tec2: text("mammogram_tec2"),
    ultrasound_tec1:
      text("ultrasound_tec1") || text("ultraSound_tec1"),
    ultrasound_tec2:
      text("ultrasound_tec2") || text("ultraSound_tec2"),
    ultrasound_tec3:
      text("ultrasound_tec3") || text("ultraSound_tec3"),
    ultrasound_tec4:
      text("ultrasound_tec4") || text("ultraSound_tec4"),
    ultrasound_tec5:
      text("ultrasound_tec5") || text("ultraSound_tec5"),
    ultrasound_tec6:
      text("ultrasound_tec6") || text("ultraSound_tec6"),
    stereo_biop_position:
      text("stereo_biop_position") || text("StereoBiopPosition"),
    us_guided_bx_position:
      text("us_guided_bx_position") || text("USGuidedBxPosition"),
    aspiration_position:
      text("aspiration_position") || text("AspirationPosition"),
    ductogram_film: text("ductogram_film") || text("DuctogramFilm"),
    copy_film_film: text("copy_film_film") || text("CopyFilmFilm"),
    cash: text("cash") || text("Cash"),
    schedule_date: normalizeBillingDatetimeToPg(
      getField(raw, "schedule_date") ?? getField(raw, "ScheduleDate"),
    ),
    opd: text("opd") || text("OPD"),
    opd_price: num("opd_price") || num("OPD_Price"),
    foreigner: text("foreigner") || text("Foreigner"),
  };
}

export const BILLING_STAGING_COLUMNS = [
  "exam_id",
  "exam_date",
  "pid",
  "is_in_patient",
  "can_claim_expense",
  "hnno",
  "an",
  "room",
  "building",
  "codeno",
  "note",
  "patient_type",
  "total",
  "receipt",
  "receipt_no",
  "a",
  "a_price",
  "b",
  "b_price",
  "c",
  "c_price",
  "d",
  "d_price",
  "e",
  "e_price",
  "f",
  "f_price",
  "g",
  "g_price",
  "h",
  "h_price",
  "i",
  "i_price",
  "j",
  "j_price",
  "k",
  "k_price",
  "l",
  "l_price",
  "m",
  "m_price",
  "n",
  "n_price",
  "o",
  "o_price",
  "p",
  "p_price",
  "q",
  "q_price",
  "r",
  "r_price",
  "s",
  "s_price",
  "t",
  "t_price",
  "u",
  "u_price",
  "mammogram_tec1",
  "mammogram_tec2",
  "ultrasound_tec1",
  "ultrasound_tec2",
  "ultrasound_tec3",
  "ultrasound_tec4",
  "ultrasound_tec5",
  "ultrasound_tec6",
  "stereo_biop_position",
  "us_guided_bx_position",
  "aspiration_position",
  "ductogram_film",
  "copy_film_film",
  "cash",
  "schedule_date",
  "opd",
  "opd_price",
  "foreigner",
];
