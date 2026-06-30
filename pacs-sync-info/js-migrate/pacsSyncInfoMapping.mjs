import crypto from "node:crypto";
import { ensurePlaceholderPatientInfoFromStaging } from "../../shared/js-migrate/ensurePlaceholderPatientInfo.mjs";

const INT_RE = /^-?\d+$/;

function getField(row, key) {
  return row[key] ?? row[key.toLowerCase()] ?? row[key.toUpperCase()];
}

function nullIfTrimEmpty(v) {
  if (v == null) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
}

function normAccession(v) {
  const t = nullIfTrimEmpty(v);
  return t == null ? "" : t;
}

/** accession ว่างจาก MSSQL — สร้างคีย์สังเคราะห์ไม่ชนกับ staging PK (รวมลำดับแถวใน migration) */
export function syntheticPacsSyncAccessionFromRaw(raw, rowOrdinal) {
  const keys = [
    "pid",
    "exam_id",
    "dl_dt",
    "modality",
    "seriesperformed",
    "status",
    "isnormalstudy",
    "studyno",
    "studydescription",
    "ismarkdel",
    "pacssynctime",
    "worklistcode",
    "riscode",
    "syncfilename",
  ];
  const parts = keys.map((k) => String(getField(raw, k) ?? ""));
  parts.push(`ord:${String(rowOrdinal)}`);
  const h = crypto
    .createHash("sha256")
    .update(parts.join("\x1e"), "utf8")
    .digest("hex")
    .slice(0, 40);
  return `__mig_blank__${h}`;
}

/**
 * ปรับ datetime จาก MSSQL / ISO เป็นรูปแบบที่ PostgreSQL timestamp ยอมรับ
 */
export function normalizePacsDatetimeToPg(value) {
  const t = nullIfTrimEmpty(value);
  if (t == null) return "";
  const s = String(t).replace("T", " ").replace(/\.\d{3}Z$/i, "").replace(/Z$/i, "");
  if (s.length >= 19 && s[4] === "-" && s[7] === "-") {
    const yearRaw = Number.parseInt(s.slice(0, 4), 10);
    if (Number.isFinite(yearRaw) && yearRaw >= 2200) {
      const yyyy = String(yearRaw - 543).padStart(4, "0");
      return `${yyyy}${s.slice(4)}`;
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

function toSqlValueExpr(baseExpr, colMeta) {
  const dt = colMeta.data_type;
  const udt = colMeta.udt_name;
  if (dt === "integer" || dt === "smallint" || dt === "bigint") {
    return `
      CASE
        WHEN ${baseExpr} IS NULL OR btrim(${baseExpr}::text) = '' THEN NULL
        WHEN btrim(${baseExpr}::text) ~ '^-?[0-9]+$' THEN btrim(${baseExpr}::text)::bigint
        ELSE NULL
      END`;
  }
  if (dt.includes("timestamp")) {
    return `CASE WHEN ${baseExpr} IS NULL OR btrim(${baseExpr}::text) = '' THEN NULL ELSE btrim(${baseExpr}::text)::timestamp END`;
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

/**
 * MSSQL rows -> staging shape (เหมือน examination_general normalize)
 */
export function normalizePacsSyncMssqlRow(raw, rowOrdinal = 0) {
  let accessionId = normAccession(getField(raw, "accession_id"));
  if (!accessionId) {
    accessionId = syntheticPacsSyncAccessionFromRaw(raw, rowOrdinal);
  }

  const examRaw = getField(raw, "exam_id");
  const examStr =
    examRaw == null || String(examRaw).trim() === ""
      ? ""
      : String(examRaw).trim();

  return {
    accession_id: accessionId,
    pid: nullIfTrimEmpty(getField(raw, "pid")) ?? "",
    exam_id: INT_RE.test(examStr) ? examStr : "",
    dl_dt: normalizePacsDatetimeToPg(getField(raw, "dl_dt")),
    modality: nullIfTrimEmpty(getField(raw, "modality")) ?? "",
    seriesperformed: nullIfTrimEmpty(getField(raw, "seriesperformed")) ?? "",
    status: nullIfTrimEmpty(getField(raw, "status")) ?? "",
    isnormalstudy: nullIfTrimEmpty(getField(raw, "isnormalstudy")) ?? "",
    studyno: nullIfTrimEmpty(getField(raw, "studyno")) ?? "",
    studydescription: nullIfTrimEmpty(getField(raw, "studydescription")) ?? "",
    ismarkdel: nullIfTrimEmpty(getField(raw, "ismarkdel")) ?? "",
    pacssynctime: normalizePacsDatetimeToPg(getField(raw, "pacssynctime")),
    worklistcode: nullIfTrimEmpty(getField(raw, "worklistcode")) ?? "",
    riscode: nullIfTrimEmpty(getField(raw, "riscode")) ?? "",
    syncfilename: nullIfTrimEmpty(getField(raw, "syncfilename")) ?? "",
  };
}

const SKIP_TARGET_COLS = new Set([
  "id",
  "user_created",
  "date_created",
  "user_updated",
  "date_updated",
]);

/** staging column -> Directus/target column เมื่อชื่อไม่เหมือนกัน */
const SOURCE_FIELD_BY_TARGET = {
  old_pid: "pid",
  old_exam_id: "exam_id",
  dl_dt: "dl_dt",
  study_no: "studyno",
  study_description: "studydescription",
  is_normal_study: "isnormalstudy",
  is_mark_del: "ismarkdel",
  pacs_sync_time: "pacssynctime",
  worklist_code: "worklistcode",
  ris_code: "riscode",
  sync_file_name: "syncfilename",
};

let pacsSyncInfoTargetColumnsCache = null;

/** เรียกก่อนรัน migrate เผื่อเปลี่ยน schema target ใน session เดียวกัน */
export function resetPacsSyncInfoTargetColumnCache() {
  pacsSyncInfoTargetColumnsCache = null;
}

async function getCachedPacsSyncInfoTargetColumns(pgClient) {
  if (pacsSyncInfoTargetColumnsCache) return pacsSyncInfoTargetColumnsCache;
  pacsSyncInfoTargetColumnsCache = await existingColumns(pgClient, "pacs_sync_info");
  return pacsSyncInfoTargetColumnsCache;
}

/**
 * staging มีข้อมูล chunk ปัจจุบันแล้ว — ลบเฉพาะ accession ที่อยู่ใน staging แล้ว INSERT
 */
export async function runPacsSyncInfoChunkPostLoad(pgClient) {
  await ensurePlaceholderPatientInfoFromStaging(
    pgClient,
    "migrate_stg.pacs_sync_info_mssql",
  );

  const cols = await getCachedPacsSyncInfoTargetColumns(pgClient);
  if (!cols.has("accession_id")) {
    throw new Error(
      'target public.pacs_sync_info must have column "accession_id"',
    );
  }

  if (cols.has("id")) {
    await pgClient.query(
      `
      CREATE TEMP TABLE IF NOT EXISTS pacs_sync_info_keep_id (
        accession_id TEXT PRIMARY KEY,
        id BIGINT NOT NULL
      ) ON COMMIT PRESERVE ROWS;
      TRUNCATE pacs_sync_info_keep_id;
      INSERT INTO pacs_sync_info_keep_id (accession_id, id)
      SELECT NULLIF(btrim(s.accession_id::text), ''), p.id::bigint
      FROM migrate_stg.pacs_sync_info_mssql s
      INNER JOIN public.pacs_sync_info p
        ON p.accession_id::text = s.accession_id::text
      WHERE NULLIF(btrim(s.accession_id::text), '') IS NOT NULL
      `,
    );
  }

  await pgClient.query(
    `
    DELETE FROM public.pacs_sync_info p
    USING migrate_stg.pacs_sync_info_mssql s
    WHERE p.accession_id::text = s.accession_id::text
    `,
  );

  const insertColumns = [];
  const selectExprs = [];

  const addExpr = (name, expr) => {
    insertColumns.push(name);
    selectExprs.push(expr);
  };

  for (const [name, meta] of cols.entries()) {
    if (SKIP_TARGET_COLS.has(name)) continue;

    let expr = null;
    if (name === "id") {
      expr = `COALESCE(
        id_keep.id,
        nextval(pg_get_serial_sequence('public.pacs_sync_info', 'id'))
      )`;
    } else if (name === "accession_id") {
      expr = toSqlValueExpr(`s.accession_id`, meta) ?? `NULLIF(btrim(s.accession_id::text), '')`;
    } else if (name === "patient") {
      expr = `pat.id`;
    } else if (name === "exam") {
      expr = `e.id`;
    } else if (["modality", "seriesperformed", "status"].includes(name)) {
      expr = toSqlValueExpr(`s.${name}`, meta);
    } else if (SOURCE_FIELD_BY_TARGET[name]) {
      const src = SOURCE_FIELD_BY_TARGET[name];
      const raw = `s.${src}::text`;
      expr =
        src === "dl_dt" || src === "pacssynctime"
          ? `CASE WHEN ${raw} IS NULL OR btrim(${raw}) = '' THEN NULL ELSE btrim(${raw})::timestamp END`
          : toSqlValueExpr(raw, meta);
    }

    if (expr) addExpr(name, expr);
  }

  if (insertColumns.length === 0) {
    throw new Error("no writable columns mapped for public.pacs_sync_info");
  }
  const idKeepJoin = cols.has("id")
    ? `LEFT JOIN pacs_sync_info_keep_id id_keep
  ON id_keep.accession_id = NULLIF(btrim(s.accession_id::text), '')`
    : "";

  const sql = `
INSERT INTO public.pacs_sync_info (${insertColumns.join(", ")})
SELECT
  ${selectExprs.join(",\n  ")}
FROM migrate_stg.pacs_sync_info_mssql s
LEFT JOIN LATERAL (
  SELECT pi.id
  FROM public.patient_info pi
  WHERE NULLIF(btrim(s.pid::text), '') IS NOT NULL
    AND (
      pi.pid::text = NULLIF(btrim(s.pid::text), '')
      OR pi.old_db_id::text = NULLIF(btrim(s.pid::text), '')
    )
  ORDER BY CASE
    WHEN pi.pid::text = NULLIF(btrim(s.pid::text), '') THEN 0
    ELSE 1
  END
  LIMIT 1
) pat ON TRUE
LEFT JOIN LATERAL (
  SELECT e.id
  FROM public.examination e
  WHERE NULLIF(btrim(s.exam_id::text), '') ~ '^[0-9]+$'
    AND e.old_exam_id::text = NULLIF(btrim(s.exam_id::text), '')
  ORDER BY e.id
  LIMIT 1
) e ON TRUE
${idKeepJoin}
`.trim();

  await pgClient.query(sql);
}

export async function syncPacsSyncInfoIdSequence(pgClient) {
  await pgClient.query(`
    SELECT setval(
      pg_get_serial_sequence('public.pacs_sync_info', 'id'),
      COALESCE((SELECT MAX(id) + 1 FROM public.pacs_sync_info), 1),
      false
    )
    WHERE pg_get_serial_sequence('public.pacs_sync_info', 'id') IS NOT NULL;
  `);
}

export async function resetPacsSyncInfoIdSequenceIfEmpty(pgClient) {
  await pgClient.query(`
    WITH cnt AS (
      SELECT COUNT(*)::bigint AS c FROM public.pacs_sync_info
    )
    SELECT setval(
      pg_get_serial_sequence('public.pacs_sync_info', 'id'),
      1,
      false
    )
    FROM cnt
    WHERE cnt.c = 0
      AND pg_get_serial_sequence('public.pacs_sync_info', 'id') IS NOT NULL;
  `);
}
