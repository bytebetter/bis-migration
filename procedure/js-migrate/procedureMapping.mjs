/**
 * Mapping: MSSQL dbo.biopsy -> Directus Postgres public.procedure
 */

function getField(row, key) {
  return row[key] ?? row[key.toLowerCase()] ?? row[key.toUpperCase()];
}

function normExamId(v) {
  if (v == null) return "";
  return String(v)
    .replace(/^\uFEFF/, "")
    .trim();
}

export function normProcedureDbId(row) {
  const e = normExamId(getField(row, "exam_id"));
  const bid = normExamId(getField(row, "biopsy_id"));
  if (e === "" || bid === "") return null;
  return `${e}_${bid}`;
}

function nullIfTrimEmpty(value) {
  if (value == null) return null;
  const t = String(value).trim();
  return t === "" ? null : t;
}

function toInt(value) {
  const t = nullIfTrimEmpty(value);
  if (t == null || !/^-?\d+$/.test(t)) return null;
  return Number.parseInt(t, 10);
}

/** คืน bigint จากตัวเลขล้วหรือสตริงตัวเลข เพื่อความเข้ากันได้กับ needleno / flag */
function toMaybeBigInt(v) {
  const t = nullIfTrimEmpty(v);
  if (t == null) return null;
  if (/^-?\d+$/.test(t)) return t;
  return null;
}

function toBool(value) {
  const t = nullIfTrimEmpty(value);
  if (t == null) return null;
  if (["1", "true", "True", "Y", "y", "t", "T"].includes(t)) return true;
  if (["0", "false", "False", "N", "n", "f", "F"].includes(t)) return false;
  return null;
}

/** boolean ธรรมดา ถ้าค่าไม่ได้ระบุ map เป็น false เฉพาะ flag ที่ Directus default เป็น false */
function toBoolWithDefaultFalse(value) {
  const b = toBool(value);
  if (b !== null) return b;
  return false;
}

function toUuidOrNull(value) {
  const t = nullIfTrimEmpty(value);
  if (t == null) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    t,
  )
    ? t.toLowerCase()
    : null;
}

/**
 * MSSQL เวลา -> timestamp แบบ examination (พ.ศ. >=2200 -> ค.ศ.)
 */
function toPgTimestamp(v) {
  const t = nullIfTrimEmpty(v);
  if (t == null || t.length < 10 || t[4] !== "-") return null;

  const y = Number.parseInt(t.slice(0, 4), 10);
  const m = t.slice(5, 7);
  const d = t.slice(8, 10);
  if (!Number.isFinite(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d))
    return null;

  const yyyy = y >= 2200 ? y - 543 : y;
  const timeRaw = t.slice(10).trim();
  if (timeRaw === "") return `${yyyy}-${m}-${d} 00:00:00`;

  const timePart = timeRaw.replace("T", " ").replace("Z", "");
  const hh = timePart.slice(0, 2);
  const mi = timePart.slice(3, 5);
  const ss = timePart.slice(6, 8);
  if (!/^\d{2}$/.test(hh) || !/^\d{2}$/.test(mi) || !/^\d{2}$/.test(ss)) {
    return `${yyyy}-${m}-${d} 00:00:00`;
  }
  return `${yyyy}-${m}-${d} ${hh}:${mi}:${ss}`;
}

function toNumericNullable(v) {
  const t = nullIfTrimEmpty(v);
  if (t == null) return null;
  const n = Number.parseFloat(String(t).replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return n;
}

async function pgRelOid(pgClient, schema, table) {
  const r = await pgClient.query(
    `
      SELECT c.oid AS oid
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'
    `,
    [schema, table],
  );
  if (r.rows.length === 0) return null;
  return Number(r.rows[0].oid);
}

function valueInFkSet(set, v) {
  if (v == null) return true;
  if (set.has(v)) return true;
  if (typeof v === "number" && set.has(String(v))) return true;
  const s = String(v);
  if (/^-?\d+$/.test(s) && set.has(Number.parseInt(s, 10))) return true;
  return false;
}

let cachedExamMap = null;
let cachedProcedureFkSets = null;
let cachedProcedureVarcharLimits = null;

async function loadOldExamToPgExamId(pgClient) {
  const res = await pgClient.query(
    `
    SELECT id, old_exam_id
    FROM public.examination
    WHERE old_exam_id IS NOT NULL AND trim(old_exam_id) <> '';
    `,
  );
  const m = new Map();
  for (const row of res.rows) {
    const key = normExamId(row.old_exam_id);
    if (key !== "") m.set(key, row.id);
  }
  return m;
}

async function getOldExamToPgExamMap(pgClient) {
  if (cachedExamMap) return cachedExamMap;
  cachedExamMap = await loadOldExamToPgExamId(pgClient);
  return cachedExamMap;
}

async function loadProcedureForeignKeyAllowedSets(pgClient) {
  const oid = await pgRelOid(pgClient, "public", "procedure");
  if (oid == null)
    throw new Error(
      "Postgres: ไม่พบตาราง public.procedure (ตรวจสอบชื่อตารางปลายทาง)",
    );

  const cons = await pgClient.query(
    `
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = $1::oid
      AND c.contype = 'f'
      AND array_length(c.conkey, 1) = 1
    `,
    [oid],
  );

  const colToSet = new Map();

  for (const { conname } of cons.rows) {
    const meta = await pgClient.query(
      `
      SELECT
        child.attname AS child_col,
        n.nspname AS sch,
        p.relname AS rel,
        pa.attname AS pcol
      FROM pg_constraint c
      JOIN pg_attribute child ON child.attrelid = c.conrelid AND child.attnum = c.conkey[1]
      JOIN pg_class p ON p.oid = c.confrelid
      JOIN pg_namespace n ON n.oid = p.relnamespace
      JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
      WHERE c.conname = $1 AND c.contype = 'f'
      `,
      [conname],
    );
    if (meta.rows.length === 0) continue;
    const { child_col, sch, rel, pcol } = meta.rows[0];
    if (!/^[\w]+$/.test(sch) || !/^[\w]+$/.test(rel) || !/^[\w]+$/.test(pcol))
      continue;

    const data = await pgClient.query(
      `SELECT "${pcol}" AS v FROM "${sch}"."${rel}" WHERE "${pcol}" IS NOT NULL`,
    );
    if (data.rows.length === 0) continue;

    const set = new Set();
    for (const row of data.rows) {
      const x = row.v;
      if (x == null) continue;
      set.add(x);
      if (
        typeof x === "number" ||
        (typeof x === "string" && /^-?\d+$/.test(x))
      ) {
        set.add(Number(x));
        set.add(String(x));
      }
    }
    colToSet.set(child_col, set);
  }

  return colToSet;
}

async function getProcedureForeignKeyAllowedSets(pgClient) {
  if (cachedProcedureFkSets) return cachedProcedureFkSets;
  cachedProcedureFkSets = await loadProcedureForeignKeyAllowedSets(pgClient);
  return cachedProcedureFkSets;
}

async function loadProcedureVarcharLimits(pgClient) {
  const res = await pgClient.query(`
    SELECT column_name, character_maximum_length
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'procedure'
      AND data_type = 'character varying'
      AND character_maximum_length IS NOT NULL
  `);
  const m = new Map();
  for (const row of res.rows) {
    const limit = Number(row.character_maximum_length);
    if (!Number.isFinite(limit) || limit <= 0) continue;
    m.set(String(row.column_name), limit);
  }
  return m;
}

async function getProcedureVarcharLimits(pgClient) {
  if (cachedProcedureVarcharLimits) return cachedProcedureVarcharLimits;
  cachedProcedureVarcharLimits = await loadProcedureVarcharLimits(pgClient);
  return cachedProcedureVarcharLimits;
}

function nullOutInvalidForeignKeys(mapped, colToSet) {
  for (const [col, set] of colToSet) {
    if (!Object.hasOwn(mapped, col)) continue;
    const v = mapped[col];
    if (v == null) continue;
    if (!valueInFkSet(set, v)) mapped[col] = null;
  }
}

function trimValuesToVarcharLimit(mapped, varcharLimits, trimStats) {
  for (const [col, maxLen] of varcharLimits) {
    if (!Object.hasOwn(mapped, col)) continue;
    const v = mapped[col];
    if (typeof v !== "string") continue;
    if (v.length <= maxLen) continue;
    mapped[col] = v.slice(0, maxLen);
    trimStats.set(col, (trimStats.get(col) ?? 0) + 1);
  }
}

/**
 * แถวจาก MSSQL (staging/recordset) -> payload ที่สอดคล้องกับฟิลด์ Directus ในตาราง procedure
 */
export function mapBiopsyRowToProcedure(row, examPgId) {
  const clinical = nullIfTrimEmpty(getField(row, "clinical"));

  const payload = {
    old_db_id: normProcedureDbId(row),
    exam: examPgId,

    patient_type: toInt(getField(row, "patient_type")),
    patient_type_des: nullIfTrimEmpty(getField(row, "patient_type_des")),
    clinical,
    /** ฟิลด์นี้ไม่มีในต้นทาง MSSQL */
    review_outside_study: null,
    finding: nullIfTrimEmpty(getField(row, "finding")),
    biopsy_proc: toInt(getField(row, "biopsy_proc")),
    biopsy_proc_des: nullIfTrimEmpty(getField(row, "biopsy_proc_des")),
    state: "0",

    location: toInt(getField(row, "location")),
    assessment_others: toInt(getField(row, "assessment_others")),
    width: toNumericNullable(getField(row, "width")),
    depth: toNumericNullable(getField(row, "depth")),
    assessment_birads: toInt(getField(row, "assessment_birads")),
    assessment_birads_des: nullIfTrimEmpty(
      getField(row, "assessment_birads_des"),
    ),
    remark: toInt(getField(row, "remark")),
    remark_other: nullIfTrimEmpty(getField(row, "remark_other")),
    remark_text: nullIfTrimEmpty(getField(row, "remark_text")),
    summary_doctor: toUuidOrNull(getField(row, "summary_doctor")),
    recommend: toMaybeBigInt(getField(row, "recommend")),
    recommend_des: nullIfTrimEmpty(getField(row, "recommend_des")),
    recommend_benign: toMaybeBigInt(getField(row, "recommend_benign")),
    recommend_benign_des: nullIfTrimEmpty(
      getField(row, "recommend_benign_des"),
    ),
    recommend_highrisk: toMaybeBigInt(getField(row, "recommend_highrisk")),
    recommend_highrisk_des: nullIfTrimEmpty(
      getField(row, "recommend_highrisk_des"),
    ),
    recommend_malignant_des: nullIfTrimEmpty(
      getField(row, "recommend_malignant_des"),
    ),
    recommend_milignant: toMaybeBigInt(getField(row, "recommend_malignant")),

    technique: toInt(getField(row, "technique")),
    technique_des: nullIfTrimEmpty(getField(row, "technique_des")),
    patient_pos: toInt(getField(row, "patient_pos")),
    patient_pos_des: nullIfTrimEmpty(getField(row, "patient_pos_des")),
    breast_compress: toInt(getField(row, "breast_compress")),
    breast_compress_des: nullIfTrimEmpty(getField(row, "breast_compress_des")),
    approach_des: nullIfTrimEmpty(getField(row, "approach_des")),
    approach: toInt(getField(row, "approach")),

    result_corebiopsy_specimens: toNumericNullable(
      getField(row, "result_corebiopsy_specimens"),
    ),
    result_corebiopsy_microcal: toNumericNullable(
      getField(row, "result_corebiopsy_microcal"),
    ),
    pathocode_resultdate: toPgTimestamp(
      getField(row, "patho_code_result_date"),
    ),
    pathocode_fillby: toUuidOrNull(getField(row, "patho_code_fill_by")),
    pathocode_fulldes: nullIfTrimEmpty(getField(row, "patho_code_full_des")),
    pathocode: nullIfTrimEmpty(getField(row, "patho_code")),
    result_aspiration_cc: toNumericNullable(
      getField(row, "result_aspiration_cc"),
    ),
    result_aspiration_app: toInt(getField(row, "result_aspiration_app")),
    result_aspiration_app_des: nullIfTrimEmpty(
      getField(row, "result_aspiration_app_des"),
    ),
    result_aspiration_cytology: toBool(
      getField(row, "result_aspiration_cytology"),
    ),
    result_aspiration_culture: toBool(
      getField(row, "result_aspiration_culture"),
    ),
    result_needle_within_lesion: toBoolWithDefaultFalse(
      getField(row, "result_needle_within_lesion"),
    ),
    result_needle_mm_depth: (() => {
      const n = toNumericNullable(getField(row, "result_needle_mm_depth"));
      return n;
    })(),
    result_needle_mm_near: toNumericNullable(
      getField(row, "result_needle_mm_near"),
    ),
    result_ductography: toInt(getField(row, "result_ductography")),
    result_ductography_des: nullIfTrimEmpty(
      getField(row, "result_ductography_des"),
    ),
    result_ductography_other: nullIfTrimEmpty(
      getField(row, "result_ductography_other"),
    ),
    result_smear_noofslide: toNumericNullable(
      getField(row, "result_smear_noofslide"),
    ),
    result_smear_app: toNumericNullable(getField(row, "result_smear_app")),
    result_smear_app_des: nullIfTrimEmpty(
      getField(row, "result_smear_app_des"),
    ),
    result_needle_other: nullIfTrimEmpty(getField(row, "result_needle_other")),
    assessment_others_des: nullIfTrimEmpty(
      getField(row, "assessment_others_des"),
    ),
    spontaneous_discharge: toBool(getField(row, "spontaneous_discharge")),
    needleno: toInt(getField(row, "needle_no")),
    location_right_other: nullIfTrimEmpty(
      getField(row, "location_right_other"),
    ),
    location_left_other: nullIfTrimEmpty(getField(row, "location_left_other")),
  };

  return payload;
}

/** เก็บเฉพาะแถวที่มี Examination ปลายทาง และ distinct ด้วย key exam+biopsy */
export async function runProcedureChunkPostLoad(pgClient, mssqlRows) {
  const examMap = await getOldExamToPgExamMap(pgClient);
  const seen = new Map();
  const rowsIn = [];

  for (const row of mssqlRows) {
    const key = normProcedureDbId(row);
    if (key == null) continue;
    if (seen.has(key)) continue;
    seen.set(key, true);

    const oldExam = normExamId(getField(row, "exam_id"));
    const pgExam = examMap.get(oldExam);
    if (pgExam == null) continue;

    rowsIn.push({
      raw: row,
      examPgId: pgExam,
    });
  }

  if (rowsIn.length === 0) return;

  const oldDbIds = rowsIn
    .map((x) => normProcedureDbId(x.raw))
    .filter((v) => v != null);

  await pgClient.query(
    'DELETE FROM public."procedure" WHERE old_db_id::text = ANY($1::text[])',
    [oldDbIds],
  );

  await pgClient.query(`
    SELECT setval(
      pg_get_serial_sequence('"public"."procedure"', 'id'),
      COALESCE((SELECT MAX(id) + 1 FROM public."procedure"), 1),
      false
    );
  `);

  const fkSets = await getProcedureForeignKeyAllowedSets(pgClient);
  const varcharLimits = await getProcedureVarcharLimits(pgClient);
  const trimStats = new Map();
  const payloads = rowsIn.map(({ raw, examPgId }) => {
    const m = mapBiopsyRowToProcedure(raw, examPgId);
    nullOutInvalidForeignKeys(m, fkSets);
    trimValuesToVarcharLimit(m, varcharLimits, trimStats);
    return m;
  });

  // Intentionally silent during chunk processing to keep progress UI single-line/dynamic.

  const A = payloads;
  /** ลำดับต้องตรง unnest และ INSERT — อย่าสับใสเรียงคีย์จาก mapBiopsyRowToProcedure */

  await pgClient.query(
    `
    INSERT INTO public."procedure" (
      old_db_id,
      patient_type,
      patient_type_des,
      clinical,
      review_outside_study,
      finding,
      biopsy_proc,
      biopsy_proc_des,
      state,
      location,
      assessment_others,
      width,
      depth,
      assessment_birads,
      assessment_birads_des,
      remark,
      remark_other,
      remark_text,
      summary_doctor,
      recommend,
      recommend_des,
      recommend_benign,
      recommend_benign_des,
      recommend_highrisk,
      recommend_highrisk_des,
      recommend_malignant_des,
      recommend_milignant,
      technique,
      technique_des,
      patient_pos,
      patient_pos_des,
      breast_compress,
      breast_compress_des,
      approach_des,
      approach,
      result_corebiopsy_specimens,
      result_corebiopsy_microcal,
      exam,
      pathocode_resultdate,
      pathocode_fillby,
      pathocode_fulldes,
      pathocode,
      result_aspiration_cc,
      result_aspiration_app,
      result_aspiration_app_des,
      result_aspiration_cytology,
      result_aspiration_culture,
      result_needle_within_lesion,
      result_needle_mm_depth,
      result_needle_mm_near,
      result_ductography,
      result_ductography_des,
      result_ductography_other,
      result_smear_noofslide,
      result_smear_app,
      result_smear_app_des,
      result_needle_other,
      assessment_others_des,
      spontaneous_discharge,
      needleno,
      location_right_other,
      location_left_other
    )
    SELECT * FROM unnest(
      $1::text[],
      $2::int4[],
      $3::text[],
      $4::text[],
      $5::boolean[],
      $6::text[],
      $7::int4[],
      $8::text[],
      $9::text[],
      $10::int4[],
      $11::int4[],
      $12::numeric[],
      $13::numeric[],
      $14::int4[],
      $15::text[],
      $16::int4[],
      $17::text[],
      $18::text[],
      $19::uuid[],
      $20::bigint[],
      $21::text[],
      $22::bigint[],
      $23::text[],
      $24::bigint[],
      $25::text[],
      $26::text[],
      $27::bigint[],
      $28::int4[],
      $29::text[],
      $30::int4[],
      $31::text[],
      $32::int4[],
      $33::text[],
      $34::text[],
      $35::int4[],
      $36::numeric[],
      $37::numeric[],
      $38::int4[],
      $39::timestamp[],
      $40::uuid[],
      $41::text[],
      $42::text[],
      $43::numeric[],
      $44::int4[],
      $45::text[],
      $46::boolean[],
      $47::boolean[],
      $48::boolean[],
      $49::numeric[],
      $50::numeric[],
      $51::int4[],
      $52::text[],
      $53::text[],
      $54::numeric[],
      $55::numeric[],
      $56::text[],
      $57::text[],
      $58::text[],
      $59::boolean[],
      $60::int4[],
      $61::text[],
      $62::text[]
    )
    `,
    [
      A.map((p) => p.old_db_id),
      A.map((p) => p.patient_type),
      A.map((p) => p.patient_type_des),
      A.map((p) => p.clinical),
      A.map((p) => p.review_outside_study),
      A.map((p) => p.finding),
      A.map((p) => p.biopsy_proc),
      A.map((p) => p.biopsy_proc_des),
      A.map((p) => p.state),
      A.map((p) => p.location),
      A.map((p) => p.assessment_others),
      A.map((p) => p.width),
      A.map((p) => p.depth),
      A.map((p) => p.assessment_birads),
      A.map((p) => p.assessment_birads_des),
      A.map((p) => p.remark),
      A.map((p) => p.remark_other),
      A.map((p) => p.remark_text),
      A.map((p) => p.summary_doctor),
      A.map((p) => p.recommend),
      A.map((p) => p.recommend_des),
      A.map((p) => p.recommend_benign),
      A.map((p) => p.recommend_benign_des),
      A.map((p) => p.recommend_highrisk),
      A.map((p) => p.recommend_highrisk_des),
      A.map((p) => p.recommend_malignant_des),
      A.map((p) => p.recommend_milignant),
      A.map((p) => p.technique),
      A.map((p) => p.technique_des),
      A.map((p) => p.patient_pos),
      A.map((p) => p.patient_pos_des),
      A.map((p) => p.breast_compress),
      A.map((p) => p.breast_compress_des),
      A.map((p) => p.approach_des),
      A.map((p) => p.approach),
      A.map((p) => p.result_corebiopsy_specimens),
      A.map((p) => p.result_corebiopsy_microcal),
      A.map((p) => p.exam),
      A.map((p) => p.pathocode_resultdate),
      A.map((p) => p.pathocode_fillby),
      A.map((p) => p.pathocode_fulldes),
      A.map((p) => p.pathocode),
      A.map((p) => p.result_aspiration_cc),
      A.map((p) => p.result_aspiration_app),
      A.map((p) => p.result_aspiration_app_des),
      A.map((p) => p.result_aspiration_cytology),
      A.map((p) => p.result_aspiration_culture),
      A.map((p) => p.result_needle_within_lesion),
      A.map((p) => p.result_needle_mm_depth),
      A.map((p) => p.result_needle_mm_near),
      A.map((p) => p.result_ductography),
      A.map((p) => p.result_ductography_des),
      A.map((p) => p.result_ductography_other),
      A.map((p) => p.result_smear_noofslide),
      A.map((p) => p.result_smear_app),
      A.map((p) => p.result_smear_app_des),
      A.map((p) => p.result_needle_other),
      A.map((p) => p.assessment_others_des),
      A.map((p) => p.spontaneous_discharge),
      A.map((p) => p.needleno),
      A.map((p) => p.location_right_other),
      A.map((p) => p.location_left_other),
    ],
  );
}

export const MSSQL_PROCEDURE_DEST_FIELD_PAIRS = [
  ["exam_id", "(join) exam via public.examination.old_exam_id"],
  ["biopsy_id", "old_db_id composite"],
  ["PatientType", "patient_type"],
  ["PatientType_Des", "patient_type_des"],
  ["Clinical", "clinical"],
  ["Finding", "finding"],
  ["BiopsyProc", "biopsy_proc"],
  ["BiopsyProc_Des", "biopsy_proc_des"],
  ["Location", "location"],
  ["Assessment_Others", "assessment_others"],
  ["Width", "width"],
  ["Depth", "depth"],
  ["Assessment_BIRADS", "assessment_birads"],
  ["Assessment_BIRADS_Des", "assessment_birads_des"],
  ["Remark", "remark"],
  ["Remark_Other", "remark_other"],
  ["Remark_Text", "remark_text"],
  ["Summary_Doctor", "summary_doctor"],
  ["Recommend*", "recommend_*"],
  ["Technique", "technique"],
  ["PatientPos", "patient_pos"],
  ["BreastCompress", "breast_compress"],
  ["Approach", "approach / approach_des"],
  ["Result_* / Patho*", "เหมือนชื่อคอลัมน์ Directus snake_case"],
];
