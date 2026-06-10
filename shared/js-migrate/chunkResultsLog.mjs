/**
 * บันทึก chunkResults ลง migrate log (รูปแบบเดียวกับ patient_info / appointment)
 *
 * chunkLogMode (default "full" = ทุก chunk ในรอบนั้น):
 *   full    — เก็บทุก chunk
 *   compact — chunk 1, ทุก chunkSampleEvery, และ chunk ที่ fail
 *   none    — เฉพาะ chunk ที่ fail
 */

/**
 * @param {object} [migrationConfig]
 * @param {{ chunkLogMode?: string, chunkSampleEvery?: number }} [defaults]
 */
export function readChunkLogConfig(
  migrationConfig = {},
  defaults = { chunkLogMode: "full", chunkSampleEvery: 50 },
) {
  return {
    chunkLogMode: String(
      migrationConfig.chunkLogMode ?? defaults.chunkLogMode ?? "full",
    ),
    chunkSampleEvery: Math.max(
      1,
      Number(migrationConfig.chunkSampleEvery ?? defaults.chunkSampleEvery ?? 50),
    ),
  };
}

/**
 * @param {{
 *   status: string,
 *   chunkIndex: number,
 *   chunkLogMode: string,
 *   chunkSampleEvery: number,
 * }} p
 */
export function shouldKeepChunkDetail(p) {
  const { status, chunkIndex, chunkLogMode, chunkSampleEvery } = p;
  if (chunkLogMode === "none") return status === "failed";
  if (chunkLogMode === "full") return true;
  if (status === "failed") return true;
  return chunkIndex === 1 || chunkIndex % chunkSampleEvery === 0;
}

/**
 * @param {object} [migrationConfig]
 * @param {{ chunkLogMode?: string, chunkSampleEvery?: number }} [defaults]
 */
export function createChunkResultsLogger(
  migrationConfig = {},
  defaults = { chunkLogMode: "full", chunkSampleEvery: 50 },
) {
  const { chunkLogMode, chunkSampleEvery } = readChunkLogConfig(
    migrationConfig,
    defaults,
  );
  /** @type {Record<string, unknown>[]} */
  const chunkResults = [];
  let chunkCount = 0;

  /**
   * @param {Record<string, unknown>} entry
   */
  function record(entry) {
    const chunkIndex = Number(entry.chunkIndex ?? 0);
    if (chunkIndex > chunkCount) chunkCount = chunkIndex;
    const status = String(entry.status ?? "success");
    if (
      shouldKeepChunkDetail({
        status,
        chunkIndex,
        chunkLogMode,
        chunkSampleEvery,
      })
    ) {
      chunkResults.push(entry);
    }
  }

  /**
   * @param {Record<string, unknown>} entry
   */
  function recordFailure(entry) {
    const chunkIndex = Number(entry.chunkIndex ?? 0);
    if (chunkIndex > chunkCount) chunkCount = chunkIndex;
    chunkResults.push({ ...entry, status: "failed" });
  }

  /**
   * @param {Record<string, unknown>} runLog
   */
  function attachTo(runLog) {
    runLog.chunkResults = chunkResults;
    runLog.chunkCount = chunkCount;
    runLog.chunkLogMode = chunkLogMode;
  }

  return {
    chunkLogMode,
    chunkSampleEvery,
    chunkResults,
    get chunkCount() {
      return chunkCount;
    },
    record,
    recordFailure,
    attachTo,
  };
}

/**
 * @param {object[]} rows
 * @param {string} field
 * @param {(v: unknown) => unknown} [pick]
 */
export function firstLastRowField(rows, field, pick = (v) => v) {
  if (!rows?.length) return { first: null, last: null };
  const read = (row) => {
    if (!row || typeof row !== "object") return null;
    const want = field.toLowerCase();
    const hit = Object.keys(row).find((k) => k.toLowerCase() === want);
    return pick(hit ? row[hit] : null);
  };
  return { first: read(rows[0]), last: read(rows[rows.length - 1]) };
}

/**
 * @param {object[]} rows
 * @param {string} examField
 * @param {string} childField
 */
export function firstLastCompositeKey(rows, examField, childField) {
  const keyOf = (row) => {
    if (!row || typeof row !== "object") return null;
    const read = (field) => {
      const want = field.toLowerCase();
      const hit = Object.keys(row).find((k) => k.toLowerCase() === want);
      const v = hit ? row[hit] : null;
      if (v == null) return "";
      return String(v).trim();
    };
    const e = read(examField);
    const c = read(childField);
    if (e && c) return `${e}_${c}`;
    return e || c || null;
  };
  if (!rows?.length) return { firstKey: null, lastKey: null };
  return { firstKey: keyOf(rows[0]), lastKey: keyOf(rows[rows.length - 1]) };
}
