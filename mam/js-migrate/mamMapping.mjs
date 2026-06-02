import sql from "mssql";
import { ensurePlaceholderPatientInfoFromStaging } from "../../shared/js-migrate/ensurePlaceholderPatientInfo.mjs";

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

export async function runMamChunkPostLoad(
  pgClient,
  stagingFromClause = "migrate_stg.mam_mssql",
) {
  await ensurePlaceholderPatientInfoFromStaging(pgClient, stagingFromClause);

  const cols = await existingColumns(pgClient, "mammogram");
  if (!cols.has("old_exam_id") && !cols.has("exam")) {
    throw new Error("target public.mammogram must have exam or old_exam_id");
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

    if (cols.has("id")) {
      await pgClient.query(`
        CREATE TEMP TABLE IF NOT EXISTS mammogram_keep_id (
          old_exam_id TEXT PRIMARY KEY,
          id BIGINT NOT NULL
        ) ON COMMIT PRESERVE ROWS;
        TRUNCATE mammogram_keep_id;
        INSERT INTO mammogram_keep_id (old_exam_id, id)
        SELECT NULLIF(btrim(s.exam_id), '')::text, t.id::bigint
        FROM ${stagingFromClause} s
        INNER JOIN public.mammogram t
          ON t.old_exam_id = ${stgExamExpr}
        WHERE NULLIF(btrim(s.exam_id), '') ~ '^[0-9]+$';
      `);
    }

    await pgClient.query(
      `DELETE FROM public.mammogram
       WHERE old_exam_id IN (
         SELECT ${stgExamExpr}
         FROM ${stagingFromClause} s
         WHERE NULLIF(btrim(s.exam_id), '') ~ '^[0-9]+$'
       );`,
    );
  } else {
    if (cols.has("id")) {
      await pgClient.query(`
        CREATE TEMP TABLE IF NOT EXISTS mammogram_keep_id (
          old_exam_id TEXT PRIMARY KEY,
          id BIGINT NOT NULL
        ) ON COMMIT PRESERVE ROWS;
        TRUNCATE mammogram_keep_id;
        INSERT INTO mammogram_keep_id (old_exam_id, id)
        SELECT NULLIF(btrim(s.exam_id), '')::text, m.id::bigint
        FROM ${stagingFromClause} s
        INNER JOIN public.examination e
          ON e.old_exam_id::text = NULLIF(btrim(s.exam_id), '')
        INNER JOIN public.mammogram m
          ON m.exam = e.id
        WHERE NULLIF(btrim(s.exam_id), '') ~ '^[0-9]+$';
      `);
    }
    await pgClient.query(
      `DELETE FROM public.mammogram m
       USING ${stagingFromClause} s
       INNER JOIN public.examination e
         ON e.old_exam_id::text = NULLIF(btrim(s.exam_id), '')
       WHERE m.exam = e.id
         AND NULLIF(btrim(s.exam_id), '') ~ '^[0-9]+$';`,
    );
  }

  if (cols.has("id")) {
    await pgClient.query(`
      SELECT setval(
        pg_get_serial_sequence('public.mammogram', 'id'),
        COALESCE((SELECT MAX(id) + 1 FROM public.mammogram), 1),
        false
      )
      WHERE pg_get_serial_sequence('public.mammogram', 'id') IS NOT NULL;
    `);
  }

  const sourceFieldByTarget = {
    old_exam_id: "exam_id",
    old_pid: "pid",
    exam_date: "exam_date",
    breast_composition: "breastcomposition",
    breast_composition_des: "breastcomposition_des",
    implant: "implant",
    implant_des: "implant_des",
    implant_finding: "implant_finding",
    implant_finding_des: "implant_finding_des",
    technique: "technique",
    r_technique: "r_technique",
    l_technique: "l_technique",
    technique_des: "technique_des",
    mass: "mass",
    mass_des: "mass_des",
    num_of_mass_actual_found: "num_of_mass_actualfound",
    cal: "cal",
    cal_des: "cal_des",
    num_of_cal_actual_found: "num_of_cal_actualfound",
    r_specialcase: "r_specialcase",
    r_specialcase_des: "r_specialcase_des",
    l_specialcase: "l_specialcase",
    l_specialcase_des: "l_specialcase_des",
    r_ass_finding: "r_assfinding",
    r_ass_finding_des: "r_assfinding_des",
    l_ass_finding: "l_assfinding",
    l_ass_finding_des: "l_assfinding_des",
    is_convert_from_old_system: "isconvertfromoldsystem",
    l_implant: "l_implant",
    l_implant_des: "l_implant_des",
    l_implant_finding: "l_implant_finding",
    l_implant_finding_des: "l_implant_finding_des",
    r_implant: "implant",
    r_implant_des: "implant_des",
    r_implant_finding: "implant_finding",
    r_implant_finding_des: "implant_finding_des",
    r_addproc_mag: "r_addproc_mag",
    l_addproc_mag: "l_addproc_mag",
    r_addproc_spot_mag: "r_addproc_spot_mag",
    l_addproc_spot_mag: "l_addproc_spot_mag",
    r_addproc_coned_compression: "r_addproc_coned_compression",
    l_addproc_coned_compression: "l_addproc_coned_compression",
    r_addproc_coned_exag_cc: "r_addproc_coned_exag_cc",
    l_addproc_coned_exag_cc: "l_addproc_coned_exag_cc",
    r_addproc_other: "r_addproc_other",
    l_addproc_other: "l_addproc_other",
    r_addproc_other_des: "r_addproc_other_des",
    l_addproc_other_des: "l_addproc_other_des",
  };

  const insertColumns = [];
  const selectExprs = [];
  for (const [name, meta] of cols.entries()) {
    let expr = null;
    if (name === "id")
      expr = `COALESCE(
        id_keep.id,
        nextval(pg_get_serial_sequence('public.mammogram', 'id'))
      )`;
    else if (name === "exam") expr = "e.id";
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
    throw new Error("no compatible columns found on public.mammogram");
  }

  const patientJoin = cols.has("patient")
    ? `LEFT JOIN public.patient_info p
  ON p.pid::text = NULLIF(btrim(s.pid), '')`
    : "";
  const idKeepJoin = cols.has("id")
    ? `LEFT JOIN mammogram_keep_id id_keep
  ON id_keep.old_exam_id = NULLIF(btrim(s.exam_id), '')`
    : "";

  const sql = `
INSERT INTO public.mammogram (${insertColumns.join(", ")})
SELECT
  ${selectExprs.join(",\n  ")}
FROM ${stagingFromClause} s
LEFT JOIN public.examination e
  ON e.old_exam_id::text = NULLIF(btrim(s.exam_id), '')
${patientJoin}
${idKeepJoin}
WHERE NULLIF(btrim(s.exam_id), '') ~ '^[0-9]+$';
`.trim();
  await pgClient.query(sql);
}

export const MAM_STAGING_COLUMNS = [
  "exam_id",
  "exam_date",
  "pid",
  "breastcomposition",
  "breastcomposition_des",
  "implant",
  "implant_des",
  "implant_finding",
  "implant_finding_des",
  "technique",
  "r_technique",
  "l_technique",
  "technique_des",
  "mass",
  "mass_des",
  "num_of_mass_actualfound",
  "cal",
  "cal_des",
  "num_of_cal_actualfound",
  "r_addproc_mag",
  "l_addproc_mag",
  "r_addproc_spot_mag",
  "l_addproc_spot_mag",
  "r_addproc_coned_compression",
  "l_addproc_coned_compression",
  "r_addproc_coned_exag_cc",
  "l_addproc_coned_exag_cc",
  "r_addproc_other",
  "l_addproc_other",
  "r_addproc_other_des",
  "l_addproc_other_des",
  "r_specialcase",
  "r_specialcase_des",
  "l_specialcase",
  "l_specialcase_des",
  "r_assfinding",
  "r_assfinding_des",
  "l_assfinding",
  "l_assfinding_des",
  "isconvertfromoldsystem",
  "l_implant",
  "l_implant_des",
  "l_implant_finding",
  "l_implant_finding_des",
];

export function summarizeMamMassFromChildCount(count) {
  if (count <= 0) {
    return {
      mass: "1",
      mass_des: "No mass found",
      num_of_mass_actualfound: "",
    };
  }
  if (count === 1) {
    return {
      mass: "2",
      mass_des: "Single mass",
      num_of_mass_actualfound: "",
    };
  }
  return {
    mass: "3",
    mass_des: "Multiple masses",
    num_of_mass_actualfound: String(count),
  };
}

export function summarizeMamCalFromChildCount(count) {
  if (count <= 0) {
    return {
      cal: "1",
      cal_des: "No calcification found",
      num_of_cal_actualfound: "",
    };
  }
  if (count === 1) {
    return {
      cal: "2",
      cal_des: "Single calcification",
      num_of_cal_actualfound: "",
    };
  }
  return {
    cal: "3",
    cal_des: "Multiple calcifications = ",
    num_of_cal_actualfound: String(count),
  };
}

export function applyMamSummaryFromChildCounts(row, { massCount = 0, calCount = 0 }) {
  Object.assign(row, summarizeMamMassFromChildCount(massCount));
  Object.assign(row, summarizeMamCalFromChildCount(calCount));
  return row;
}

export async function fetchMamChildCountsByExamIds(
  mssqlPool,
  { massTableNoLock, calTableNoLock },
  examIds,
) {
  const massCounts = new Map();
  const calCounts = new Map();
  const uniq = [
    ...new Set(
      examIds
        .map((x) => Number.parseInt(String(x), 10))
        .filter((x) => Number.isFinite(x)),
    ),
  ];
  for (let i = 0; i < uniq.length; i += 500) {
    const batch = uniq.slice(i, i + 500);
    if (batch.length === 0) continue;
    const placeholders = batch.map((_, idx) => `@e${idx}`).join(", ");

    const massReq = mssqlPool.request();
    batch.forEach((id, idx) => massReq.input(`e${idx}`, sql.BigInt, id));
    const massRes = await massReq.query(
      `SELECT CAST([Exam_ID] AS BIGINT) AS exam_id, COUNT_BIG(1) AS cnt
       FROM ${massTableNoLock}
       WHERE [Exam_ID] IN (${placeholders})
       GROUP BY [Exam_ID]`,
    );
    for (const row of massRes.recordset ?? []) {
      massCounts.set(Number(row.exam_id), Number(row.cnt));
    }

    const calReq = mssqlPool.request();
    batch.forEach((id, idx) => calReq.input(`e${idx}`, sql.BigInt, id));
    const calRes = await calReq.query(
      `SELECT CAST([Exam_ID] AS BIGINT) AS exam_id, COUNT_BIG(1) AS cnt
       FROM ${calTableNoLock}
       WHERE [Exam_ID] IN (${placeholders})
       GROUP BY [Exam_ID]`,
    );
    for (const row of calRes.recordset ?? []) {
      calCounts.set(Number(row.exam_id), Number(row.cnt));
    }
  }
  return { massCounts, calCounts };
}

export function normalizeMssqlRow(raw) {
  const examId = toStrictInt(raw?.exam_id);
  if (examId == null) return null;
  const out = { exam_id: String(examId) };
  for (const col of MAM_STAGING_COLUMNS) {
    if (col === "exam_id") continue;
    if (col === "exam_date") {
      out[col] = toPgTimestamp(raw?.exam_date) ?? "";
      continue;
    }
    out[col] = nullIfTrimEmpty(raw?.[col]) ?? "";
  }
  return out;
}
