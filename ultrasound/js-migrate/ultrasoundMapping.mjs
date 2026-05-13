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

export async function runUltrasoundChunkPostLoad(
  pgClient,
  stagingFromClause = "migrate_stg.ultrasound_mssql",
) {
  const cols = await existingColumns(pgClient, "ultrasound");
  if (!cols.has("old_exam_id")) {
    throw new Error("target public.ultrasound must have old_exam_id");
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
    `DELETE FROM public.ultrasound
     WHERE old_exam_id IN (
       SELECT ${stgExamExpr}
       FROM ${stagingFromClause} s
       WHERE NULLIF(btrim(s.exam_id), '') ~ '^[0-9]+$'
     );`,
  );

  if (cols.has("id")) {
    await pgClient.query(`
      SELECT setval(
        pg_get_serial_sequence('public.ultrasound', 'id'),
        COALESCE((SELECT MAX(id) + 1 FROM public.ultrasound), 1),
        false
      )
      WHERE pg_get_serial_sequence('public.ultrasound', 'id') IS NOT NULL;
    `);
  }

  const sourceFieldByTarget = {
    old_exam_id: "exam_id",
    old_pid: "pid",
    exam_date: "exam_date",
    mass: "mass",
    mass_des: "mass_des",
    num_of_mass_found: "num_of_mass_found",
    num_of_mass_actual_found: "num_of_mass_actualfound",
    cyst: "cyst",
    cyst_des: "cyst_des",
    num_of_cyst_found: "num_of_cyst_found",
    num_of_cyst_actual_found: "num_of_cyst_actualfound",
    tissue_composition: "tissuecomposition",
    tissue_composition_des: "tissuecomposition_des",
    r_associated_features: "r_associatedfeatures",
    r_associated_features_des: "r_associatedfeatures_des",
    l_associated_features: "l_associatedfeatures",
    l_associated_features_des: "l_associatedfeatures_des",
    r_specialcase: "r_specialcase",
    r_specialcase_des: "r_specialcase_des",
    l_specialcase: "l_specialcase",
    l_specialcase_des: "l_specialcase_des",
    technique: "technique",
    technique_des: "technique_des",
  };

  const insertColumns = [];
  const selectExprs = [];
  for (const [name, meta] of cols.entries()) {
    let expr = null;
    if (name === "exam") expr = "e.id";
    else if (name === "exam_id") {
      const rawExamId = "NULLIF(btrim(s.exam_id), '')";
      expr = toSqlValueExpr(rawExamId, meta) ?? `${rawExamId}::bigint`;
    }     else if (name === "patient") expr = "p.id";
    else if (name === "payload") expr = "'{}'::jsonb";
    else if (name === "state") {
      expr =
        meta.data_type === "integer" ||
        meta.data_type === "smallint" ||
        meta.data_type === "bigint"
          ? "0"
          : `'0'`;
    }
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
    throw new Error("no compatible columns found on public.ultrasound");
  }

  const sql = `
INSERT INTO public.ultrasound (${insertColumns.join(", ")})
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
    mass: nullIfTrimEmpty(raw?.mass) ?? "",
    mass_des: nullIfTrimEmpty(raw?.mass_des) ?? "",
    num_of_mass_found: nullIfTrimEmpty(raw?.num_of_mass_found) ?? "",
    num_of_mass_actualfound:
      nullIfTrimEmpty(raw?.num_of_mass_actualfound) ?? "",
    cyst: nullIfTrimEmpty(raw?.cyst) ?? "",
    cyst_des: nullIfTrimEmpty(raw?.cyst_des) ?? "",
    num_of_cyst_found: nullIfTrimEmpty(raw?.num_of_cyst_found) ?? "",
    num_of_cyst_actualfound:
      nullIfTrimEmpty(raw?.num_of_cyst_actualfound) ?? "",
    tissuecomposition: nullIfTrimEmpty(raw?.tissuecomposition) ?? "",
    tissuecomposition_des: nullIfTrimEmpty(raw?.tissuecomposition_des) ?? "",
    r_associatedfeatures: nullIfTrimEmpty(raw?.r_associatedfeatures) ?? "",
    r_associatedfeatures_des:
      nullIfTrimEmpty(raw?.r_associatedfeatures_des) ?? "",
    l_associatedfeatures: nullIfTrimEmpty(raw?.l_associatedfeatures) ?? "",
    l_associatedfeatures_des:
      nullIfTrimEmpty(raw?.l_associatedfeatures_des) ?? "",
    r_specialcase: nullIfTrimEmpty(raw?.r_specialcase) ?? "",
    r_specialcase_des: nullIfTrimEmpty(raw?.r_specialcase_des) ?? "",
    l_specialcase: nullIfTrimEmpty(raw?.l_specialcase) ?? "",
    l_specialcase_des: nullIfTrimEmpty(raw?.l_specialcase_des) ?? "",
    technique: nullIfTrimEmpty(raw?.technique) ?? "",
    technique_des: nullIfTrimEmpty(raw?.technique_des) ?? "",
  };
}
