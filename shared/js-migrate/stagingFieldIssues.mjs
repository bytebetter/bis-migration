import { sourceRawNonempty } from "./fieldIssueLog.mjs";

const INT_RE = /^-?\d+$/;

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

/**
 * @returns {{ recordIssues: (id: string, meta: object, issues: object[]) => void, buildChunkResult: (rowsInserted: number) => object|null }}
 */
export function createChunkFieldIssueCollector(recordIdKey) {
  let totalFieldIssueCount = 0;
  /** @type {Map<string, object>} */
  const recordsById = new Map();

  function recordIssues(id, meta, issues) {
    if (issues.length === 0 || id == null || String(id).trim() === "") return;
    const key = String(id);
    totalFieldIssueCount += issues.length;
    let rec = recordsById.get(key);
    if (!rec) {
      rec = { [recordIdKey]: key, fieldIssues: [], ...meta };
      recordsById.set(key, rec);
    } else {
      for (const [k, v] of Object.entries(meta)) {
        if (v != null) rec[k] = v;
      }
    }
    rec.fieldIssues.push(...issues);
  }

  function buildChunkResult(rowsInserted) {
    if (totalFieldIssueCount === 0) return { fieldIssues: null };
    return {
      fieldIssues: {
        totalFieldIssueCount,
        rowsInserted,
        records: [...recordsById.values()],
      },
    };
  }

  return { recordIdKey, recordIssues, buildChunkResult };
}

function mergeChunkResults(...parts) {
  let totalFieldIssueCount = 0;
  let rowsInserted = 0;
  /** @type {object[]} */
  const records = [];
  const seen = new Map();

  for (const part of parts) {
    const fi = part?.fieldIssues;
    if (!fi) continue;
    totalFieldIssueCount += fi.totalFieldIssueCount ?? 0;
    rowsInserted += fi.rowsInserted ?? 0;
    for (const rec of fi.records ?? []) {
      const idKey = Object.keys(rec).find(
        (k) => k !== "fieldIssues" && k !== "pid" && k !== "patient_info_id",
      );
      const id = idKey ? String(rec[idKey]) : JSON.stringify(rec);
      const prev = seen.get(id);
      if (prev) {
        prev.fieldIssues.push(...(rec.fieldIssues ?? []));
      } else {
        const copy = { ...rec, fieldIssues: [...(rec.fieldIssues ?? [])] };
        seen.set(id, copy);
        records.push(copy);
      }
    }
  }

  if (totalFieldIssueCount === 0) return { fieldIssues: null };
  return {
    fieldIssues: {
      totalFieldIssueCount,
      rowsInserted,
      records,
    },
  };
}

/**
 * แถวที่ normalize ไม่ผ่าน + ฟิลด์วันที่ใน staging ที่แปลงไม่ได้
 */
export function collectStagingNormalizeFieldIssues(
  mssqlRows,
  normalizeFn,
  config,
) {
  const collector = createChunkFieldIssueCollector(config.recordIdKey);
  const {
    recordIdKey,
    getRecordIdFromRaw,
    getRecordIdFromNorm,
    invalidRecordReason = "invalid_exam_id",
    invalidRecordMessage = "exam_id ในแหล่งข้อมูลไม่ใช่ตัวเลขที่ใช้ migrate ได้",
    invalidRecordFields = ["exam_id"],
    timestampFields = ["exam_date"],
    compositeInvalid,
  } = config;

  for (const raw of mssqlRows) {
    const norm = normalizeFn(raw);
    if (norm) {
      const id = getRecordIdFromNorm(norm);
      for (const field of timestampFields) {
        const srcRaw = getField(raw, field);
        const mappedVal = norm[field];
        if (sourceRawNonempty(srcRaw) && mappedVal === "") {
          collector.recordIssues(
            id,
            config.buildMeta?.(raw, norm) ?? {},
            [
              {
                field,
                reason: "datetime_parse_failed",
                message: "วันที่/เวลาในแหล่งข้อมูลแปลงไม่ได้",
                source_raw: srcRaw,
                mapped: null,
              },
            ],
          );
        }
      }
      continue;
    }

    if (compositeInvalid) {
      const { fields, reason, message, buildId } = compositeInvalid;
      const bad = fields.some((f) => sourceRawNonempty(getField(raw, f)));
      if (!bad) continue;
      const id = buildId(raw);
      collector.recordIssues(id, config.buildMeta?.(raw, null) ?? {}, [
        {
          field: "_record",
          reason,
          message,
          source_raw: Object.fromEntries(
            fields.map((f) => [f, getField(raw, f)]),
          ),
          mapped: null,
        },
      ]);
      continue;
    }

    const idRaw = getRecordIdFromRaw?.(raw) ?? getField(raw, recordIdKey);
    if (!sourceRawNonempty(idRaw)) continue;
    for (const f of invalidRecordFields) {
      if (!sourceRawNonempty(getField(raw, f))) continue;
    }
    const id = String(idRaw).trim();
    collector.recordIssues(id, config.buildMeta?.(raw, null) ?? {}, [
      {
        field: invalidRecordFields[0] ?? recordIdKey,
        reason: invalidRecordReason,
        message: invalidRecordMessage,
        source_raw: idRaw,
        mapped: null,
      },
    ]);
  }

  return collector.buildChunkResult(0);
}

/**
 * ตรวจหลัง post-load: exam/patient ไม่ resolve, แถวหายหลัง insert
 */
export async function verifyExamKeyedStagingChunk(pgClient, options) {
  const {
    recordIdKey = "exam_id",
    targetTable,
    stagingFromClause,
    stagingExamCol = "exam_id",
    stagingPidCol = "pid",
    targetKeyColumn = "old_exam_id",
    hasPatientColumn = true,
    hasExamColumn = true,
    buildMeta,
  } = options;

  const collector = createChunkFieldIssueCollector(recordIdKey);
  const stgExam = `NULLIF(btrim(s.${stagingExamCol}), '')`;
  const stgPid = `NULLIF(btrim(s.${stagingPidCol}), '')`;

  if (hasExamColumn) {
    const { rows } = await pgClient.query(
      `
      SELECT ${stgExam} AS exam_id, ${stgPid} AS pid
      FROM ${stagingFromClause} s
      LEFT JOIN public.examination e
        ON e.old_exam_id::text = ${stgExam}
      WHERE ${stgExam} ~ '^[0-9]+$'
        AND e.id IS NULL
      `,
    );
    for (const r of rows) {
      collector.recordIssues(
        String(r.exam_id),
        buildMeta?.(r) ?? { pid: r.pid ?? null },
        [
          {
            field: "exam",
            reason: "exam_not_resolved",
            message: "มี exam_id ในแหล่งข้อมูล แต่ไม่พบใน public.examination",
            source_raw: r.exam_id,
            mapped: null,
          },
        ],
      );
    }
  }

  if (hasPatientColumn) {
    const { rows } = await pgClient.query(
      `
      SELECT ${stgExam} AS exam_id, ${stgPid} AS pid
      FROM ${stagingFromClause} s
      LEFT JOIN public.patient_info p
        ON p.pid::text = ${stgPid}
      WHERE ${stgPid} IS NOT NULL
        AND ${stgExam} ~ '^[0-9]+$'
        AND p.id IS NULL
      `,
    );
    for (const r of rows) {
      collector.recordIssues(
        String(r.exam_id),
        buildMeta?.(r) ?? { pid: r.pid ?? null },
        [
          {
            field: "patient",
            reason: "patient_not_resolved",
            message: "มี pid ในแหล่งข้อมูล แต่ไม่พบใน public.patient_info",
            source_raw: r.pid,
            mapped: null,
          },
        ],
      );
    }
  }

  const keyMeta = await pgClient.query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [targetTable, targetKeyColumn],
  );
  const keyIsInt =
    keyMeta.rows[0]?.data_type === "integer" ||
    keyMeta.rows[0]?.data_type === "bigint" ||
    keyMeta.rows[0]?.data_type === "smallint";
  const targetKeyExpr = keyIsInt
    ? `t.${targetKeyColumn}`
    : `t.${targetKeyColumn}::text`;

  const { rows: missing } = await pgClient.query(
    `
    SELECT ${stgExam} AS exam_id, ${stgPid} AS pid
    FROM ${stagingFromClause} s
    WHERE ${stgExam} ~ '^[0-9]+$'
      AND NOT EXISTS (
        SELECT 1 FROM public.${targetTable} t
        WHERE ${targetKeyExpr} = ${keyIsInt ? `${stgExam}::int` : stgExam}
      )
    `,
  );
  for (const r of missing) {
    collector.recordIssues(
      String(r.exam_id),
      buildMeta?.(r) ?? { pid: r.pid ?? null },
      [
        {
          field: "_record",
          reason: "insert_missing_after_migrate",
          message: `แมปและ insert แล้ว แต่ไม่พบแถวใน public.${targetTable}`,
          source_raw: r.exam_id,
          mapped: null,
        },
      ],
    );
  }

  return collector.buildChunkResult(0);
}

export async function verifyCompositeStagingChunk(pgClient, options) {
  const {
    recordIdKey = "record_key",
    targetTable,
    stagingFromClause,
    stagingExamCol = "exam_id",
    stagingChildCol = "described_mass_id",
    targetExamCol = "old_exam_id",
    targetChildCol = "described_mass_id",
    buildRecordId = (r) => `${r.exam_id}_${r.child_id}`,
    buildMeta,
  } = options;

  const collector = createChunkFieldIssueCollector(recordIdKey);
  const stgExam = `NULLIF(btrim(s.${stagingExamCol}), '')`;
  const stgChild = `NULLIF(btrim(s.${stagingChildCol}), '')`;

  const { rows: missingExam } = await pgClient.query(
    `
    SELECT ${stgExam} AS exam_id, ${stgChild} AS child_id
    FROM ${stagingFromClause} s
    LEFT JOIN public.examination e ON e.old_exam_id::text = ${stgExam}
    WHERE ${stgExam} ~ '^[0-9]+$'
      AND ${stgChild} ~ '^[0-9]+$'
      AND e.id IS NULL
    `,
  );
  for (const r of missingExam) {
    const id = buildRecordId(r);
    collector.recordIssues(id, buildMeta?.(r) ?? {}, [
      {
        field: "exam",
        reason: "exam_not_resolved",
        message: "มี exam_id ในแหล่งข้อมูล แต่ไม่พบใน public.examination",
        source_raw: r.exam_id,
        mapped: null,
      },
    ]);
  }

  const { rows: missing } = await pgClient.query(
    `
    SELECT ${stgExam} AS exam_id, ${stgChild} AS child_id
    FROM ${stagingFromClause} s
    WHERE ${stgExam} ~ '^[0-9]+$'
      AND ${stgChild} ~ '^[0-9]+$'
      AND NOT EXISTS (
        SELECT 1 FROM public.${targetTable} t
        WHERE t.${targetExamCol}::text = ${stgExam}
          AND t.${targetChildCol}::text = ${stgChild}
      )
    `,
  );
  for (const r of missing) {
    const id = buildRecordId(r);
    collector.recordIssues(id, buildMeta?.(r) ?? {}, [
      {
        field: "_record",
        reason: "insert_missing_after_migrate",
        message: `แมปและ insert แล้ว แต่ไม่พบแถวใน public.${targetTable}`,
        source_raw: { exam_id: r.exam_id, [stagingChildCol]: r.child_id },
        mapped: null,
      },
    ]);
  }

  return collector.buildChunkResult(0);
}

export function collectPacsSyncNormalizeFieldIssues(mssqlRows, normalizeFn) {
  const collector = createChunkFieldIssueCollector("accession_id");
  const timestampFields = ["dl_dt", "pacssynctime"];

  for (let i = 0; i < mssqlRows.length; i++) {
    const raw = mssqlRows[i];
    const norm = normalizeFn(raw, i);
    const accession = norm?.accession_id;
    if (accession == null) continue;

    const examRaw = getField(raw, "exam_id");
    if (sourceRawNonempty(examRaw) && norm.exam_id === "") {
      collector.recordIssues(String(accession), { pid: norm.pid ?? null }, [
        {
          field: "old_exam_id",
          reason: "integer_parse_failed",
          message: "exam_id ในแหล่งข้อมูลไม่ใช่จำนวนเต็มที่ถูกต้อง",
          source_raw: examRaw,
          mapped: null,
        },
      ]);
    }

    for (const field of timestampFields) {
      const srcRaw = getField(raw, field);
      const mappedVal = norm[field];
      if (sourceRawNonempty(srcRaw) && (mappedVal === "" || mappedVal == null)) {
        const pgField =
          field === "pacssynctime" ? "pacs_sync_time" : field === "dl_dt" ? "dl_dt" : field;
        collector.recordIssues(String(accession), { pid: norm.pid ?? null }, [
          {
            field: pgField,
            reason: "datetime_parse_failed",
            message: "วันที่/เวลาในแหล่งข้อมูลแปลงไม่ได้",
            source_raw: srcRaw,
            mapped: null,
          },
        ]);
      }
    }
  }

  return collector.buildChunkResult(0);
}

export async function verifyPacsSyncStagingChunk(pgClient, stagingFromClause) {
  const collector = createChunkFieldIssueCollector("accession_id");

  const { rows: missingPatient } = await pgClient.query(
    `
    SELECT s.accession_id, s.pid
    FROM ${stagingFromClause} s
    WHERE NULLIF(btrim(s.pid::text), '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.patient_info pi
        WHERE pi.pid::text = NULLIF(btrim(s.pid::text), '')
           OR pi.old_db_id::text = NULLIF(btrim(s.pid::text), '')
      )
    `,
  );
  for (const r of missingPatient) {
    collector.recordIssues(String(r.accession_id), { pid: r.pid ?? null }, [
      {
        field: "patient",
        reason: "patient_not_resolved",
        message: "มี pid ในแหล่งข้อมูล แต่ไม่พบใน public.patient_info",
        source_raw: r.pid,
        mapped: null,
      },
    ]);
  }

  const { rows: missingExam } = await pgClient.query(
    `
    SELECT s.accession_id, s.exam_id, s.pid
    FROM ${stagingFromClause} s
    WHERE NULLIF(btrim(s.exam_id::text), '') ~ '^[0-9]+$'
      AND NOT EXISTS (
        SELECT 1 FROM public.examination e
        WHERE e.old_exam_id::text = NULLIF(btrim(s.exam_id::text), '')
      )
    `,
  );
  for (const r of missingExam) {
    collector.recordIssues(String(r.accession_id), { pid: r.pid ?? null }, [
      {
        field: "exam",
        reason: "exam_not_resolved",
        message: "มี exam_id ในแหล่งข้อมูล แต่ไม่พบใน public.examination",
        source_raw: r.exam_id,
        mapped: null,
      },
    ]);
  }

  const { rows: missing } = await pgClient.query(
    `
    SELECT s.accession_id, s.pid
    FROM ${stagingFromClause} s
    WHERE NOT EXISTS (
      SELECT 1 FROM public.pacs_sync_info p
      WHERE p.accession_id::text = s.accession_id::text
    )
    `,
  );
  for (const r of missing) {
    collector.recordIssues(String(r.accession_id), { pid: r.pid ?? null }, [
      {
        field: "_record",
        reason: "insert_missing_after_migrate",
        message: "แมปและ insert แล้ว แต่ไม่พบแถวใน public.pacs_sync_info",
        source_raw: r.accession_id,
        mapped: null,
      },
    ]);
  }

  return collector.buildChunkResult(0);
}

export function mergeStagingFieldIssueParts(...parts) {
  return mergeChunkResults(...parts);
}

export async function runExamKeyedStagingFieldIssuePipeline(
  pgClient,
  mssqlRows,
  normalizeFn,
  normalizeConfig,
  verifyOptions,
  rowsInserted = 0,
) {
  const normIssues = collectStagingNormalizeFieldIssues(
    mssqlRows,
    normalizeFn,
    normalizeConfig,
  );
  const verifyIssues = await verifyExamKeyedStagingChunk(pgClient, verifyOptions);
  const merged = mergeStagingFieldIssueParts(normIssues, verifyIssues);
  if (merged.fieldIssues) merged.fieldIssues.rowsInserted = rowsInserted;
  return merged;
}

export async function runCompositeStagingFieldIssuePipeline(
  pgClient,
  mssqlRows,
  normalizeFn,
  normalizeConfig,
  verifyOptions,
  rowsInserted = 0,
) {
  const normIssues = collectStagingNormalizeFieldIssues(
    mssqlRows,
    normalizeFn,
    normalizeConfig,
  );
  const verifyIssues = await verifyCompositeStagingChunk(pgClient, verifyOptions);
  const merged = mergeStagingFieldIssueParts(normIssues, verifyIssues);
  if (merged.fieldIssues) merged.fieldIssues.rowsInserted = rowsInserted;
  return merged;
}

export function buildCompositeStagingFieldIssueConfig(childCol, targetTable, stagingFrom) {
  return {
    normalizeConfig: {
      recordIdKey: "record_key",
      getRecordIdFromNorm: (n) => `${n.exam_id}_${n[childCol]}`,
      compositeInvalid: {
        fields: ["exam_id", childCol],
        reason: "invalid_composite_key",
        message: `exam_id หรือ ${childCol} ในแหล่งข้อมูลไม่ใช่ตัวเลขที่ใช้ migrate ได้`,
        buildId: (raw) => `${raw?.exam_id ?? "?"}_${raw?.[childCol] ?? "?"}`,
      },
      timestampFields: ["exam_date"],
      buildMeta: (raw, norm) => {
        if (!norm) return {};
        return {
          record_key: `${norm.exam_id}_${norm[childCol]}`,
          exam_id: norm.exam_id,
          [childCol]: norm[childCol],
          pid: norm.pid ?? null,
        };
      },
    },
    verifyOptions: {
      recordIdKey: "record_key",
      targetTable,
      stagingFromClause: stagingFrom,
      stagingChildCol: childCol,
      targetChildCol: childCol,
      buildRecordId: (r) => `${r.exam_id}_${r.child_id}`,
      buildMeta: (r) => ({
        record_key: `${r.exam_id}_${r.child_id}`,
        exam_id: r.exam_id,
        [childCol]: r.child_id,
        pid: r.pid ?? null,
      }),
    },
  };
}

export async function runPacsSyncStagingFieldIssuePipeline(
  pgClient,
  mssqlRows,
  normalizeFn,
  stagingFromClause,
  rowsInserted = 0,
) {
  const normIssues = collectPacsSyncNormalizeFieldIssues(mssqlRows, normalizeFn);
  const verifyIssues = await verifyPacsSyncStagingChunk(pgClient, stagingFromClause);
  const merged = mergeStagingFieldIssueParts(normIssues, verifyIssues);
  if (merged.fieldIssues) merged.fieldIssues.rowsInserted = rowsInserted;
  return merged;
}

/**
 * update-only: exam_id ใน staging ไม่มีแถวเป้าหมายใน public.examination_general
 */
export async function verifyExaminationGeneralUpdateTargetChunk(
  pgClient,
  options = {},
) {
  const {
    recordIdKey = "exam_id",
    stagingFromClause = "migrate_stg.exam_recommend_birads45_mssql",
    stagingExamCol = "exam_id",
    stagingPidCol = "pid",
    buildMeta,
  } = options;

  const collector = createChunkFieldIssueCollector(recordIdKey);
  const stgExam = `NULLIF(btrim(s.${stagingExamCol}), '')`;
  const stgPid = `NULLIF(btrim(s.${stagingPidCol}), '')`;

  const { rows } = await pgClient.query(
    `
    SELECT DISTINCT ${stgExam} AS exam_id, ${stgPid} AS pid
    FROM ${stagingFromClause} s
    LEFT JOIN public.examination_general t
      ON t.old_exam_id::text = ${stgExam}
    WHERE ${stgExam} ~ '^[0-9]+$'
      AND t.id IS NULL
    `,
  );
  for (const r of rows) {
    collector.recordIssues(
      String(r.exam_id),
      buildMeta?.(r) ?? { pid: r.pid ?? null },
      [
        {
          field: "examination_general",
          reason: "update_target_missing",
          message:
            "มี exam_id ในแหล่งข้อมูล แต่ไม่พบแถวใน public.examination_general สำหรับ update recommendation_des",
          source_raw: r.exam_id,
          mapped: null,
        },
      ],
    );
  }

  return collector.buildChunkResult(0);
}

export async function runExamRecommendBirads45StagingFieldIssuePipeline(
  pgClient,
  mssqlRows,
  normalizeFn,
  rowsLoaded = 0,
  stagingFromClause = "migrate_stg.exam_recommend_birads45_mssql",
) {
  const normIssues = collectStagingNormalizeFieldIssues(mssqlRows, normalizeFn, {
    recordIdKey: "exam_id",
    getRecordIdFromRaw: (r) => r?.exam_id ?? r?.Exam_ID,
    getRecordIdFromNorm: (n) => n.exam_id,
    compositeInvalid: {
      fields: ["exam_id", "recommend_id"],
      reason: "invalid_recommend_row",
      message:
        "exam_id หรือ recommend_id ในแหล่งข้อมูลไม่ใช่ตัวเลขที่ใช้ migrate ได้",
      buildId: (raw) => {
        const exam = String(raw?.exam_id ?? raw?.Exam_ID ?? "").trim();
        if (exam) return exam;
        const rec = String(raw?.recommend_id ?? raw?.Recommend_ID ?? "").trim();
        return rec || "?";
      },
    },
    timestampFields: ["exam_date"],
    buildMeta: (raw, norm) => ({
      pid: norm?.pid ?? raw?.pid ?? raw?.PID ?? null,
    }),
  });
  const verifyIssues = await verifyExaminationGeneralUpdateTargetChunk(pgClient, {
    stagingFromClause,
    buildMeta: (r) => ({ pid: r.pid ?? null }),
  });
  const merged = mergeStagingFieldIssueParts(normIssues, verifyIssues);
  if (merged.fieldIssues) merged.fieldIssues.rowsInserted = rowsLoaded;
  return merged;
}

export { getField, INT_RE };
