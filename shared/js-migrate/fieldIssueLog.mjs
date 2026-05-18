import fs from "node:fs";
import path from "node:path";

export function sourceRawNonempty(v) {
  if (v == null) return false;
  return (
    String(v)
      .replace(/^\uFEFF/, "")
      .trim() !== ""
  );
}

export function sortRecordIds(ids) {
  const out = [...ids];
  out.sort((a, b) => {
    try {
      const aa = BigInt(a);
      const bb = BigInt(b);
      return aa < bb ? -1 : aa > bb ? 1 : 0;
    } catch {
      return String(a).localeCompare(String(b));
    }
  });
  return out;
}

export function buildFieldIssueSummary(recordIssues) {
  /** @type {Record<string, Record<string, number>>} */
  const summaryByField = {};
  /** @type {Record<string, number>} */
  const summaryByReason = {};

  for (const rec of recordIssues) {
    for (const fi of rec.fieldIssues ?? []) {
      const f = fi.field;
      const r = fi.reason;
      if (!summaryByField[f]) summaryByField[f] = {};
      summaryByField[f][r] = (summaryByField[f][r] ?? 0) + 1;
      summaryByReason[r] = (summaryByReason[r] ?? 0) + 1;
    }
  }
  return { summaryByField, summaryByReason };
}

/**
 * @param {string} recordIdKey คีย์ในแต่ละ record เช่น exam_id หรือ pid
 */
export function createFieldIssueAccumulator(recordIdKey = "id") {
  return {
    recordIdKey,
    /** @type {Map<string, object>} */
    recordsById: new Map(),
    totalFieldIssueCount: 0,
    rowsInserted: 0,
    /** ค่าเสริมใน summary (เช่น referringNullified, addressRowsInserted) */
    summaryExtras: {},
  };
}

export function mergeFieldIssueChunk(accumulator, chunkResult) {
  if (!accumulator || !chunkResult) return;
  const fi = chunkResult.fieldIssues;
  if (!fi) return;

  const idKey = accumulator.recordIdKey;
  accumulator.totalFieldIssueCount += fi.totalFieldIssueCount ?? 0;
  accumulator.rowsInserted += fi.rowsInserted ?? 0;

  if (fi.summaryExtras && typeof fi.summaryExtras === "object") {
    for (const [k, v] of Object.entries(fi.summaryExtras)) {
      if (typeof v === "number") {
        accumulator.summaryExtras[k] = (accumulator.summaryExtras[k] ?? 0) + v;
      } else {
        accumulator.summaryExtras[k] = v;
      }
    }
  }

  for (const rec of fi.records ?? []) {
    const id = String(rec[idKey]);
    const prev = accumulator.recordsById.get(id);
    if (prev) {
      prev.fieldIssues.push(...(rec.fieldIssues ?? []));
    } else {
      accumulator.recordsById.set(id, {
        ...rec,
        fieldIssues: [...(rec.fieldIssues ?? [])],
      });
    }
  }
}

export function writeFieldIssueLogFile(logPath, payload) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, "w");
  try {
    const head = {
      type: payload.type,
      generatedAt: payload.generatedAt,
      migrationKey: payload.migrationKey,
      summary: payload.summary,
    };
    const headJson = JSON.stringify(head, null, 2);
    fs.writeSync(fd, `${headJson.slice(0, -1)},\n  "records": {\n`);

    const keys = sortRecordIds(Object.keys(payload.records ?? {}));
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const recJson = JSON.stringify(payload.records[k]);
      const suffix = i < keys.length - 1 ? ",\n" : "\n";
      fs.writeSync(fd, `    ${JSON.stringify(k)}: ${recJson}${suffix}`);
    }
    fs.writeSync(fd, "  }\n}\n");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * @param {object} accumulator
 * @param {{ migrationKey?: string, logType: string, recordIdKey?: string, buildRecord?: (rec: object) => object }} options
 */
export function buildFieldIssueLogPayload(accumulator, options) {
  const idKey = options.recordIdKey ?? accumulator.recordIdKey ?? "id";
  const allRecords = [...accumulator.recordsById.values()];
  const { summaryByField, summaryByReason } =
    buildFieldIssueSummary(allRecords);

  const buildRecord =
    options.buildRecord ??
    ((rec) => ({
      [idKey]: String(rec[idKey]),
      fieldIssues: rec.fieldIssues ?? [],
    }));

  /** @type {Record<string, object>} */
  const records = {};
  for (const rec of allRecords) {
    const id = String(rec[idKey]);
    records[id] = buildRecord(rec);
  }

  return {
    type: options.logType,
    generatedAt: new Date().toISOString(),
    migrationKey: options.migrationKey ?? null,
    summary: {
      affectedRecordCount: allRecords.length,
      totalFieldIssueCount: accumulator.totalFieldIssueCount,
      rowsInserted: accumulator.rowsInserted,
      byField: summaryByField,
      byReason: summaryByReason,
      ...(accumulator.summaryExtras ?? {}),
    },
    records,
  };
}
