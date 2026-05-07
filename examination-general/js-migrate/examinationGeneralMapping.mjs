const INT_RE = /^-?\d+$/;

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

function toPgTimestamp(v) {
  const t = nullIfTrimEmpty(v);
  if (t == null || t.length < 10 || t[4] !== "-") return null;
  const y = Number.parseInt(t.slice(0, 4), 10);
  const m = t.slice(5, 7);
  const d = t.slice(8, 10);
  if (!Number.isFinite(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d))
    return null;
  const yyyy = y >= 2400 ? y - 543 : y;
  const dt = new Date(
    Date.UTC(yyyy, Number.parseInt(m, 10) - 1, Number.parseInt(d, 10)),
  );
  if (
    Number.isNaN(dt.getTime()) ||
    dt.getUTCFullYear() !== yyyy ||
    dt.getUTCMonth() !== Number.parseInt(m, 10) - 1 ||
    dt.getUTCDate() !== Number.parseInt(d, 10)
  ) {
    return null;
  }
  return `${yyyy}-${m}-${d} 00:00:00`;
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
    return `${baseExpr}::int`;
  }
  if (dt.includes("timestamp")) {
    return `${baseExpr}::timestamp`;
  }
  if (dt === "boolean") {
    return `CASE
      WHEN ${baseExpr} IS NULL THEN NULL
      WHEN lower(${baseExpr}) IN ('1','true','t','yes','y') THEN true
      WHEN lower(${baseExpr}) IN ('0','false','f','no','n') THEN false
      ELSE NULL
    END`;
  }
  if (dt === "json" || dt === "jsonb") {
    return `CASE
      WHEN ${baseExpr} IS NULL THEN NULL
      WHEN ${baseExpr} ~ '^-?\\d+$' THEN to_jsonb((${baseExpr})::int)
      ELSE to_jsonb(${baseExpr})
    END`;
  }
  if (dt === "uuid") {
    return `CASE
      WHEN ${baseExpr} IS NULL THEN NULL
      WHEN ${baseExpr} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN ${baseExpr}::uuid
      ELSE NULL
    END`;
  }
  if (dt === "character varying") {
    const maxLen = Number(colMeta.character_maximum_length ?? 0);
    if (Number.isFinite(maxLen) && maxLen > 0) {
      return `LEFT(${baseExpr}, ${maxLen})`;
    }
    return baseExpr;
  }
  if (udt && udt.startsWith("_")) return null;
  return baseExpr;
}

export async function runExaminationGeneralChunkPostLoad(
  pgClient,
  stagingFromClause = "migrate_stg.examination_general_mssql",
) {
  const cols = await existingColumns(pgClient, "examination_general");
  if (!cols.has("old_exam_id")) {
    throw new Error("target public.examination_general must have old_exam_id");
  }

  const oldExamMeta = cols.get("old_exam_id");
  const oldExamIsInt =
    oldExamMeta &&
    (oldExamMeta.data_type === "integer" ||
      oldExamMeta.data_type === "smallint" ||
      oldExamMeta.data_type === "bigint");
  const stgExamExpr = oldExamIsInt
    ? "NULLIF(btrim(s.exam_id), '')::int"
    : "NULLIF(btrim(s.exam_id), '')";

  await pgClient.query(
    `DELETE FROM public.examination_general
     WHERE old_exam_id IN (
       SELECT ${stgExamExpr}
       FROM ${stagingFromClause} s
       WHERE NULLIF(btrim(s.exam_id), '') ~ '^[0-9]+$'
     );`,
  );

  // Align auto-increment sequence like other migration modules.
  if (cols.has("id")) {
    await pgClient.query(`
      SELECT setval(
        pg_get_serial_sequence('public.examination_general', 'id'),
        COALESCE((SELECT MAX(id) + 1 FROM public.examination_general), 1),
        false
      )
      WHERE pg_get_serial_sequence('public.examination_general', 'id') IS NOT NULL;
    `);
  }

  const sourceFieldByTarget = {
    old_exam_id: "exam_id",
    old_pid: "pid",
    patientexamtype: "patientexamtype",
    patientexamtype_des: "patientexamtype_des",
    followup: "followup",
    followup_des: "followup_des",
    pe: "pe",
    pe_des: "pe_des",
    assessment_birads: "assessment_birads",
    assessment_birads_des: "assessment_birads_des",
    recommendation: "recommendation",
    recommendation_followupmounths: "recommendation_followupmounths",
    exam_date: "exam_date",
    r_recommendation_coned_compression: "r_recommendation_coned_compression",
    l_recommendation_coned_compression: "l_recommendation_coned_compression",
    r_recommendation_spot_mag: "r_recommendation_spot_mag",
    l_recommendation_spot_mag: "l_recommendation_spot_mag",
    r_recommendation_mag: "r_recommendation_mag",
    l_recommendation_mag: "l_recommendation_mag",
    r_recommendation_coned_compression_des:
      "r_recommendation_coned_compression_des",
    l_recommendation_coned_compression_des:
      "l_recommendation_coned_compression_des",
    r_recommendation_spot_mag_des: "r_recommendation_spot_mag_des",
    l_recommendation_spot_mag_des: "l_recommendation_spot_mag_des",
    r_recommendation_mag_des: "r_recommendation_mag_des",
    l_recommendation_mag_des: "l_recommendation_mag_des",
    impression: "impression",
    impression_des: "impression_des",
    impression_lastexaminationdates: "impression_lastexaminationdates",
    radiologist: "radiologist",
    specialcase: "specialcase",
    specialcase_point: "specialcase_point",
    specialcase_point_des: "specialcase_point_des",
    specialcase_detail: "specialcase_detail",
    recommendation_followup_with: "recommendation_followup_with",
    isconvertfromoldsystem: "isconvertfromoldsystem",
    sub_birads: "sub_birads",
    followupsymptom: "followupsymptom",
    followupmonths: "followupmonths",
    followupletterprintdate: "followupletterprintdate",
    followup_date: "followup_date",
    corrected: "corrected",
    correcteddate: "correcteddate",
    screening: "screening",
    screening_des: "screening_des",
    r_followup: "r_followup",
    r_followup_des: "r_followup_des",
    l_followup: "l_followup",
    l_followup_des: "l_followup_des",
    r_problemindicated: "r_problemindicated",
    r_problemindicated_des: "r_problemindicated_des",
    l_problemindicated: "l_problemindicated",
    l_problemindicated_des: "l_problemindicated_des",
    r_palpable: "r_palpable",
    r_palpable_des: "r_palpable_des",
    l_palpable_des: "l_palpable_des",
    l_palpable: "l_palpable",
    cosign: "cosign",
  };

  const insertColumns = [];
  const selectExprs = [];
  for (const [name, meta] of cols.entries()) {
    let expr = null;
    if (name === "exam") expr = "e.id";
    else if (name === "exam_id") {
      const rawExamId = "NULLIF(btrim(s.exam_id), '')";
      expr = toSqlValueExpr(rawExamId, meta) ?? `${rawExamId}::bigint`;
    } else if (name === "patient") expr = "p.id";
    else if (name === "payload") expr = "'{}'::jsonb";
    else if (sourceFieldByTarget[name]) {
      const raw = `NULLIF(btrim(s.${sourceFieldByTarget[name]}), '')`;
      expr = toSqlValueExpr(raw, meta);
    }
    if (expr) {
      insertColumns.push(name);
      selectExprs.push(expr);
    }
  }

  if (insertColumns.length === 0) {
    throw new Error(
      "no compatible columns found on public.examination_general",
    );
  }

  const sql = `
INSERT INTO public.examination_general (${insertColumns.join(", ")})
SELECT
  ${selectExprs.join(",\n  ")}
FROM ${stagingFromClause} s
LEFT JOIN public.examination e
  ON e.old_exam_id::text = NULLIF(btrim(s.exam_id), '')
LEFT JOIN public.patient_info p
  ON p.pid::text = NULLIF(btrim(s.pid), '')
WHERE NULLIF(btrim(s.exam_id), '') ~ '^[0-9]+$';
`.trim();
  await pgClient.query(sql);
}

export function normalizeMssqlRow(raw) {
  const examId = toStrictInt(raw?.exam_id);
  if (examId == null) return null;
  return {
    exam_id: String(examId),
    exam_date: toPgTimestamp(raw?.exam_date) ?? "",
    pid: nullIfTrimEmpty(raw?.pid) ?? "",
    patientexamtype: nullIfTrimEmpty(raw?.patientexamtype) ?? "",
    patientexamtype_des: nullIfTrimEmpty(raw?.patientexamtype_des) ?? "",
    screening: nullIfTrimEmpty(raw?.screening) ?? "",
    screening_des: nullIfTrimEmpty(raw?.screening_des) ?? "",
    followup: nullIfTrimEmpty(raw?.followup) ?? "",
    followup_des: nullIfTrimEmpty(raw?.followup_des) ?? "",
    r_problemindicated: nullIfTrimEmpty(raw?.r_problemindicated) ?? "",
    r_problemindicated_des: nullIfTrimEmpty(raw?.r_problemindicated_des) ?? "",
    l_problemindicated: nullIfTrimEmpty(raw?.l_problemindicated) ?? "",
    l_problemindicated_des: nullIfTrimEmpty(raw?.l_problemindicated_des) ?? "",
    pe: nullIfTrimEmpty(raw?.pe) ?? "",
    pe_des: nullIfTrimEmpty(raw?.pe_des) ?? "",
    r_palpable: nullIfTrimEmpty(raw?.r_palpable) ?? "",
    r_palpable_des: nullIfTrimEmpty(raw?.r_palpable_des) ?? "",
    l_palpable: nullIfTrimEmpty(raw?.l_palpable) ?? "",
    l_palpable_des: nullIfTrimEmpty(raw?.l_palpable_des) ?? "",
    assessment_birads: nullIfTrimEmpty(raw?.assessment_birads) ?? "",
    assessment_birads_des: nullIfTrimEmpty(raw?.assessment_birads_des) ?? "",
    recommendation: nullIfTrimEmpty(raw?.recommendation) ?? "",
    recommendation_des_text:
      nullIfTrimEmpty(raw?.recommendation_des_text) ?? "",
    recommendation_followupmounths:
      nullIfTrimEmpty(raw?.recommendation_followupmounths) ?? "",
    r_recommendation_coned_compression:
      nullIfTrimEmpty(raw?.r_recommendation_coned_compression) ?? "",
    l_recommendation_coned_compression:
      nullIfTrimEmpty(raw?.l_recommendation_coned_compression) ?? "",
    r_recommendation_spot_mag:
      nullIfTrimEmpty(raw?.r_recommendation_spot_mag) ?? "",
    l_recommendation_spot_mag:
      nullIfTrimEmpty(raw?.l_recommendation_spot_mag) ?? "",
    r_recommendation_mag: nullIfTrimEmpty(raw?.r_recommendation_mag) ?? "",
    l_recommendation_mag: nullIfTrimEmpty(raw?.l_recommendation_mag) ?? "",
    r_recommendation_coned_compression_des:
      nullIfTrimEmpty(raw?.r_recommendation_coned_compression_des) ?? "",
    l_recommendation_coned_compression_des:
      nullIfTrimEmpty(raw?.l_recommendation_coned_compression_des) ?? "",
    r_recommendation_spot_mag_des:
      nullIfTrimEmpty(raw?.r_recommendation_spot_mag_des) ?? "",
    l_recommendation_spot_mag_des:
      nullIfTrimEmpty(raw?.l_recommendation_spot_mag_des) ?? "",
    r_recommendation_mag_des:
      nullIfTrimEmpty(raw?.r_recommendation_mag_des) ?? "",
    l_recommendation_mag_des:
      nullIfTrimEmpty(raw?.l_recommendation_mag_des) ?? "",
    impression: nullIfTrimEmpty(raw?.impression) ?? "",
    impression_des: nullIfTrimEmpty(raw?.impression_des) ?? "",
    impression_lastexaminationdates:
      nullIfTrimEmpty(raw?.impression_lastexaminationdates) ?? "",
    radiologist: nullIfTrimEmpty(raw?.radiologist) ?? "",
    specialcase: nullIfTrimEmpty(raw?.specialcase) ?? "",
    specialcase_point: nullIfTrimEmpty(raw?.specialcase_point) ?? "",
    specialcase_point_des: nullIfTrimEmpty(raw?.specialcase_point_des) ?? "",
    specialcase_detail: nullIfTrimEmpty(raw?.specialcase_detail) ?? "",
    recommendation_followup_with:
      nullIfTrimEmpty(raw?.recommendation_followup_with) ?? "",
    isconvertfromoldsystem: nullIfTrimEmpty(raw?.isconvertfromoldsystem) ?? "",
    sub_birads: nullIfTrimEmpty(raw?.sub_birads) ?? "",
    followupsymptom: nullIfTrimEmpty(raw?.followupsymptom) ?? "",
    followupmonths: nullIfTrimEmpty(raw?.followupmonths) ?? "",
    followupletterprintdate: toPgTimestamp(raw?.followupletterprintdate) ?? "",
    followup_date: toPgTimestamp(raw?.followup_date) ?? "",
    corrected: nullIfTrimEmpty(raw?.corrected) ?? "",
    correcteddate: toPgTimestamp(raw?.correcteddate) ?? "",
    r_followup: nullIfTrimEmpty(raw?.r_followup) ?? "",
    r_followup_des: nullIfTrimEmpty(raw?.r_followup_des) ?? "",
    l_followup: nullIfTrimEmpty(raw?.l_followup) ?? "",
    l_followup_des: nullIfTrimEmpty(raw?.l_followup_des) ?? "",
    cosign: nullIfTrimEmpty(raw?.cosign) ?? "",
  };
}
