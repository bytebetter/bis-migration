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
  if (dt === "real" || dt === "double precision" || dt === "numeric") {
    const castType = dt === "double precision" ? "double precision" : dt;
    return `CASE
      WHEN ${baseExpr} IS NULL THEN NULL
      WHEN ${baseExpr} ~ '^-?\\d+(\\.\\d+)?$' THEN ${baseExpr}::${castType}
      ELSE NULL
    END`;
  }
  if (udt && udt.startsWith("_")) return null;
  return baseExpr;
}

export async function runUltrasoundMassChunkPostLoad(
  pgClient,
  stagingFromClause = "migrate_stg.ultrasound_mass_mssql",
) {
  const cols = await existingColumns(pgClient, "ultrasound_mass");
  if (!cols.has("described_mass_id")) {
    throw new Error("target public.ultrasound_mass must have described_mass_id");
  }
  if (!cols.has("old_exam_id") && !cols.has("exam")) {
    throw new Error(
      "target public.ultrasound_mass must have exam or old_exam_id",
    );
  }

  if (cols.has("old_exam_id")) {
    const oldExamMeta = cols.get("old_exam_id");
    const oldExamIsInt =
      oldExamMeta &&
      (oldExamMeta.data_type === "integer" ||
        oldExamMeta.data_type === "smallint" ||
        oldExamMeta.data_type === "bigint");
    const stgExamExpr = oldExamIsInt
      ? "NULLIF(btrim(s.exam_id), '')::int"
      : "NULLIF(btrim(s.exam_id), '')";
    const stgChildExpr = "NULLIF(btrim(s.described_mass_id), '')::int";

    await pgClient.query(
      `DELETE FROM public.ultrasound_mass t
       USING ${stagingFromClause} s
       WHERE t.old_exam_id = ${stgExamExpr}
         AND t.described_mass_id = ${stgChildExpr}
         AND NULLIF(btrim(s.exam_id), '') ~ '^[0-9]+$'
         AND NULLIF(btrim(s.described_mass_id), '') ~ '^[0-9]+$';`,
    );
  } else {
    await pgClient.query(
      `DELETE FROM public.ultrasound_mass t
       USING ${stagingFromClause} s
       INNER JOIN public.examination e
         ON e.old_exam_id::text = NULLIF(btrim(s.exam_id), '')
       WHERE t.exam = e.id
         AND t.described_mass_id = NULLIF(btrim(s.described_mass_id), '')::int
         AND NULLIF(btrim(s.exam_id), '') ~ '^[0-9]+$'
         AND NULLIF(btrim(s.described_mass_id), '') ~ '^[0-9]+$';`,
    );
  }

  if (cols.has("id")) {
    await pgClient.query(`
      SELECT setval(
        pg_get_serial_sequence('public.ultrasound_mass', 'id'),
        COALESCE((SELECT MAX(id) + 1 FROM public.ultrasound_mass), 1),
        false
      )
      WHERE pg_get_serial_sequence('public.ultrasound_mass', 'id') IS NOT NULL;
    `);
  }

  const sourceFieldByTarget = {
    described_mass_id: "described_mass_id",
    old_exam_id: "exam_id",
    old_pid: "pid",
    exam_date: "exam_date",
    echo_pattern: "echo_pattern",
    echo_pattern_des: "echo_pattern_des",
    shape: "shape",
    shape_des: "shape_des",
    size_width: "size_width",
    size_depth: "size_depth",
    wall_margin: "wall_margin",
    wall_margin_des: "wall_margin_des",
    cal_in_mass: "cal_in_mass",
    l_position: "l_position",
    l_position_des: "l_position_des",
    r_position: "r_position",
    r_position_des: "r_position_des",
    l_position_clock: "l_position_clock",
    r_position_clock: "r_position_clock",
    orientation: "orientation",
    orientation_des: "orientation_des",
    posterior_features: "posterior_features",
    posterior_features_des: "posterior_features_des",
    vascularity: "vascularity",
    vascularity_des: "vascularity_des",
    elasticity: "elasticity",
    elasticity_des: "elasticity_des",
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
    else if (name === "state") {
      expr =
        meta.data_type === "integer" ||
        meta.data_type === "smallint" ||
        meta.data_type === "bigint"
          ? "0"
          : `'0'`;
    } else if (sourceFieldByTarget[name]) {
      const raw = `NULLIF(btrim(s.${sourceFieldByTarget[name]}), '')`;
      expr = toSqlValueExpr(raw, meta);
    }
    if (expr) {
      insertColumns.push(name);
      selectExprs.push(expr);
    }
  }

  if (insertColumns.length === 0) {
    throw new Error("no compatible columns found on public.ultrasound_mass");
  }

  const patientJoin = cols.has("patient")
    ? `LEFT JOIN public.patient_info p
  ON p.pid::text = NULLIF(btrim(s.pid), '')`
    : "";

  const sql = `
INSERT INTO public.ultrasound_mass (${insertColumns.join(", ")})
SELECT
  ${selectExprs.join(",\n  ")}
FROM ${stagingFromClause} s
LEFT JOIN public.examination e
  ON e.old_exam_id::text = NULLIF(btrim(s.exam_id), '')
${patientJoin}
WHERE NULLIF(btrim(s.exam_id), '') ~ '^[0-9]+$'
  AND NULLIF(btrim(s.described_mass_id), '') ~ '^[0-9]+$';
`.trim();
  await pgClient.query(sql);
}

export const ULTRASOUND_MASS_STAGING_COLUMNS = [
  "described_mass_id",
  "exam_id",
  "exam_date",
  "pid",
  "echo_pattern",
  "echo_pattern_des",
  "shape",
  "shape_des",
  "size_width",
  "size_depth",
  "wall_margin",
  "wall_margin_des",
  "cal_in_mass",
  "l_position",
  "l_position_des",
  "r_position",
  "r_position_des",
  "l_position_clock",
  "r_position_clock",
  "orientation",
  "orientation_des",
  "posterior_features",
  "posterior_features_des",
  "vascularity",
  "vascularity_des",
  "elasticity",
  "elasticity_des",
];

export function normalizeMssqlRow(raw) {
  const examId = toStrictInt(raw?.exam_id);
  const childId = toStrictInt(raw?.described_mass_id);
  if (examId == null || childId == null) return null;
  const out = {
    exam_id: String(examId),
    described_mass_id: String(childId),
  };
  for (const col of ULTRASOUND_MASS_STAGING_COLUMNS) {
    if (col === "exam_id" || col === "described_mass_id") continue;
    if (col === "exam_date") {
      out[col] = toPgTimestamp(raw?.exam_date) ?? "";
      continue;
    }
    out[col] = nullIfTrimEmpty(raw?.[col]) ?? "";
  }
  return out;
}
