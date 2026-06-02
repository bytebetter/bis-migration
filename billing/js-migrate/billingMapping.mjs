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

export function resetBillingTargetColumnCache() {
  billingTargetColumnsCache = null;
  billingPostLoadSqlCache = null;
}

/** @type {{ mode: string, idMapSql: string | null, deleteSql: string | null, insertSql: string, examMapSql: string } | null} */
let billingPostLoadSqlCache = null;

const BILLING_DATE_STAGING_COLS = new Set(["exam_date", "schedule_date"]);

async function getCachedBillingTargetColumns(pgClient) {
  if (billingTargetColumnsCache) return billingTargetColumnsCache;
  billingTargetColumnsCache = await existingColumns(pgClient, "billing");
  return billingTargetColumnsCache;
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
  id BIGINT NOT NULL
) ON COMMIT PRESERVE ROWS;
TRUNCATE billing_keep_id;
INSERT INTO billing_keep_id (old_exam_id, id)
SELECT b.old_exam_id::text, b.id::bigint
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
LEFT JOIN migrate_stg.billing_exam_map em
  ON em.old_exam_id = NULLIF(btrim(s.exam_id), '')
LEFT JOIN public.patient_info p
  ON p.pid::text = NULLIF(btrim(s.pid), '')
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

  billingPostLoadSqlCache = { mode, idMapSql, deleteSql, insertSql, examMapSql };
  return billingPostLoadSqlCache;
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
 * @returns {{ mapMs: number, deleteMs: number, insertMs: number, postgresMs: number }}
 */
export async function runBillingChunkPostLoad(
  pgClient,
  migrateRowMode = "overwrite",
) {
  const postgresStartedAt = Date.now();
  const { idMapSql, deleteSql, insertSql, examMapSql } = await prepareBillingPostLoad(
    pgClient,
    migrateRowMode,
  );

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

  return {
    mapMs,
    deleteMs,
    insertMs,
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
