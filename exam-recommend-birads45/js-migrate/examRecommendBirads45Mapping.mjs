const INT_RE = /^-?\d+$/;

/** MSSQL Biopsy_Procedure → { technique, procedure } ตาม Directus recommendation_des */
const BIOPSY_PROCEDURE_MAP = new Map(
  Object.entries({
    "ultrasound guided core needle biopsy": {
      technique: "Ultrasound guided",
      procedure: "CNB",
    },
    "ultrasound guided needle localization": {
      technique: "Ultrasound guided",
      procedure: "Needle Localization",
    },
    "stereotactic core needle biopsy": {
      technique: "Stereotactic guided",
      procedure: "CNB",
    },
    "stereotactic needle localization": {
      technique: "Stereotactic guided",
      procedure: "Needle Localization",
    },
    "fine needle aspiration": {
      technique: "",
      procedure: "FNA",
    },
    aspiration: { technique: "", procedure: "Aspiration" },
    "skin mark": { technique: "", procedure: "Skin Mark" },
    ductogram: { technique: "", procedure: "Ductogram" },
    "excisional biopsy": { technique: "", procedure: "Excisional biopsy" },
  }),
);

/** location code (text/number) → { location, location_des } */
const LOCATION_BY_CODE = new Map(
  Object.entries({
    so: { location: 1, location_des: "SO" },
    sup: { location: 2, location_des: "SUP" },
    si: { location: 3, location_des: "SI" },
    outer: { location: 4, location_des: "OUTER" },
    out: { location: 4, location_des: "OUTER" },
    c: { location: 5, location_des: "C" },
    center: { location: 5, location_des: "C" },
    cen: { location: 5, location_des: "C" },
    inner: { location: 6, location_des: "INNER" },
    inn: { location: 6, location_des: "INNER" },
    io: { location: 7, location_des: "IO" },
    inf: { location: 8, location_des: "INF" },
    ii: { location: 9, location_des: "II" },
    supraclavicular: { location: 10, location_des: "Supraclavicular" },
    scv: { location: 10, location_des: "Supraclavicular" },
    axilla: { location: 11, location_des: "Axilla" },
    ax: { location: 11, location_des: "Axilla" },
    "chest-wall": { location: 13, location_des: "chest-wall" },
    "chest wall": { location: 13, location_des: "chest-wall" },
    cw: { location: 13, location_des: "chest-wall" },
    infraclavicular: { location: 14, location_des: "infraclavicular" },
  }),
);

const LOCATION_BY_NUM = new Map([
  [1, { location: 1, location_des: "SO" }],
  [2, { location: 2, location_des: "SUP" }],
  [3, { location: 3, location_des: "SI" }],
  [4, { location: 4, location_des: "OUTER" }],
  [5, { location: 5, location_des: "C" }],
  [6, { location: 6, location_des: "INNER" }],
  [7, { location: 7, location_des: "IO" }],
  [8, { location: 8, location_des: "INF" }],
  [9, { location: 9, location_des: "II" }],
  [10, { location: 10, location_des: "Supraclavicular" }],
  [11, { location: 11, location_des: "Axilla" }],
  [13, { location: 13, location_des: "chest-wall" }],
  [14, { location: 14, location_des: "infraclavicular" }],
]);

export const STAGING_COLUMNS = [
  "exam_id",
  "exam_date",
  "pid",
  "recommend_id",
  "biopsy_procedure",
  "breast_side",
  "location",
];

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

export function mapBiopsyProcedure(raw) {
  const text = nullIfTrimEmpty(raw);
  if (text == null) return { technique: "", procedure: "" };
  const mapped = BIOPSY_PROCEDURE_MAP.get(text.toLowerCase());
  if (mapped) return mapped;
  return { technique: "", procedure: text };
}

export function mapLocation(raw) {
  const text = nullIfTrimEmpty(raw);
  if (text == null) return { location: null, location_des: "" };
  if (INT_RE.test(text)) {
    const n = Number.parseInt(text, 10);
    const mapped = LOCATION_BY_NUM.get(n);
    if (mapped) return mapped;
  }
  const mapped = LOCATION_BY_CODE.get(text.toLowerCase());
  if (mapped) return mapped;
  return { location: null, location_des: text.toUpperCase() };
}

export function mapBreastSide(raw) {
  const text = nullIfTrimEmpty(raw);
  if (text == null) return "";
  const low = text.toLowerCase();
  if (low === "right" || low === "r") return "right";
  if (low === "left" || low === "l") return "left";
  return low;
}

export function buildRecommendationItem(row) {
  const { technique, procedure } = mapBiopsyProcedure(row.biopsy_procedure);
  const { location, location_des } = mapLocation(row.location);
  return {
    technique,
    procedure,
    location,
    location_des,
    side: mapBreastSide(row.breast_side),
    detail: "",
  };
}

export function normalizeMssqlRow(raw) {
  const examId = toStrictInt(raw?.exam_id ?? raw?.Exam_ID);
  const recommendId = toStrictInt(raw?.recommend_id ?? raw?.Recommend_ID);
  if (examId == null || recommendId == null) return null;
  return {
    exam_id: String(examId),
    exam_date: nullIfTrimEmpty(raw?.exam_date) ?? "",
    pid: nullIfTrimEmpty(raw?.pid) ?? "",
    recommend_id: String(recommendId),
    biopsy_procedure: nullIfTrimEmpty(raw?.biopsy_procedure) ?? "",
    breast_side: nullIfTrimEmpty(raw?.breast_side) ?? "",
    location: nullIfTrimEmpty(raw?.location) ?? "",
  };
}

export async function loadChunkToStaging(pgClient, normalizedRows) {
  const arrays = STAGING_COLUMNS.map(() => []);
  for (const r of normalizedRows) {
    if (!r) continue;
    for (let i = 0; i < STAGING_COLUMNS.length; i++) {
      arrays[i].push(r[STAGING_COLUMNS[i]] ?? "");
    }
  }
  if (arrays[0].length === 0) return 0;
  await pgClient.query("TRUNCATE TABLE migrate_stg.exam_recommend_birads45_mssql;");
  const castArgs = STAGING_COLUMNS.map((_, i) => `$${i + 1}::text[]`).join(", ");
  await pgClient.query(
    `
INSERT INTO migrate_stg.exam_recommend_birads45_mssql (${STAGING_COLUMNS.join(", ")})
SELECT * FROM unnest(${castArgs});
`.trim(),
    arrays,
  );
  return arrays[0].length;
}

/**
 * รวมแถว staging ตาม exam_id แล้ว UPDATE public.examination_general.recommendation_des เท่านั้น
 */
export async function runExamRecommendBirads45ChunkPostLoad(
  pgClient,
  stagingFromClause = "migrate_stg.exam_recommend_birads45_mssql",
) {
  const stg = await pgClient.query(
    `
SELECT
  NULLIF(btrim(exam_id), '') AS exam_id,
  NULLIF(btrim(recommend_id), '') AS recommend_id,
  biopsy_procedure,
  breast_side,
  location
FROM ${stagingFromClause}
WHERE NULLIF(btrim(exam_id), '') ~ '^[0-9]+$'
  AND NULLIF(btrim(recommend_id), '') ~ '^[0-9]+$'
ORDER BY exam_id::bigint, recommend_id::int
`.trim(),
  );

  /** @type {Map<string, object[]>} */
  const byExam = new Map();
  for (const row of stg.rows) {
    const examId = String(row.exam_id);
    if (!byExam.has(examId)) byExam.set(examId, []);
    byExam.get(examId).push(buildRecommendationItem(row));
  }

  if (byExam.size === 0) {
    return { rowsUpdated: 0, examsProcessed: 0, examsMissingTarget: 0 };
  }

  const examIds = [];
  const payloads = [];
  for (const [examId, items] of byExam.entries()) {
    examIds.push(examId);
    payloads.push(JSON.stringify(items));
  }

  const upd = await pgClient.query(
    `
UPDATE public.examination_general AS t
SET recommendation_des = src.payload::json
FROM unnest($1::text[], $2::text[]) AS src(exam_id, payload)
WHERE t.old_exam_id::text = src.exam_id
`.trim(),
    [examIds, payloads],
  );

  const found = await pgClient.query(
    `
SELECT COUNT(DISTINCT t.old_exam_id::text) AS cnt
FROM public.examination_general t
WHERE t.old_exam_id::text = ANY($1::text[])
`.trim(),
    [examIds],
  );
  const examsFound = Number(found.rows[0]?.cnt ?? 0);

  return {
    rowsUpdated: upd.rowCount ?? 0,
    examsProcessed: examIds.length,
    examsMissingTarget: Math.max(0, examIds.length - examsFound),
  };
}
