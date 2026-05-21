import fs from "node:fs";
import path from "node:path";
import { sortRecordIds } from "./fieldIssueLog.mjs";

/** @typedef {import("./migrateTableSpecs.mjs").RepairSpec} RepairSpec */

const MAX_RANGE_EXPAND = 50_000;

/**
 * @param {Record<string, unknown>} migrationConfig
 * @param {string} logsDir
 * @param {RepairSpec} spec
 * @returns {string[] | null} null = โหมด full, [] = repair แต่ไม่มี id
 */
export function resolveRepairSourceIds(migrationConfig, logsDir, spec) {
  const mode = String(migrationConfig?.migrateRunMode ?? "full");
  if (mode !== "repair-from-log") return null;

  /** @type {Set<string>} */
  const idSet = new Set();
  const sources = [];

  const runLogPath = findLatestLogFile(logsDir, spec.runLogPattern);
  if (runLogPath) {
    try {
      const runLog = JSON.parse(fs.readFileSync(runLogPath, "utf8"));
      const nBefore = idSet.size;
      spec.collectIdsFromRunLog(runLog, idSet);
      const added = idSet.size - nBefore;
      if (added > 0) sources.push(`run log (${path.basename(runLogPath)}: +${added})`);
    } catch (err) {
      console.error(
        `>>> repair-from-log: อ่าน run log ไม่ได้ (${runLogPath}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const fieldLogPath = findLatestLogFile(logsDir, spec.fieldIssuePattern);
  if (fieldLogPath) {
    try {
      const payload = JSON.parse(fs.readFileSync(fieldLogPath, "utf8"));
      const nBefore = idSet.size;
      spec.collectIdsFromFieldIssueLog(payload, idSet);
      const added = idSet.size - nBefore;
      if (added > 0) {
        sources.push(`field-issue log (${path.basename(fieldLogPath)}: +${added})`);
      }
    } catch (err) {
      console.error(
        `>>> repair-from-log: อ่าน field-issue log ไม่ได้ (${fieldLogPath}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const ids = sortRecordIds([...idSet]);
  if (sources.length > 0) {
    console.error(
      `>>> repair-from-log [${spec.tableLabel}]: ${ids.length} id จาก ${sources.join("; ")}`,
    );
  } else {
    console.error(
      `>>> repair-from-log [${spec.tableLabel}]: ไม่พบ log ใน ${logsDir} (pattern run=${spec.runLogPattern} field=${spec.fieldIssuePattern})`,
    );
  }
  return ids;
}

/**
 * @param {string[]} ids
 * @param {number} batchSize
 */
export function* batchIds(ids, batchSize) {
  const n = Math.max(1, batchSize);
  for (let i = 0; i < ids.length; i += n) {
    yield ids.slice(i, i + n);
  }
}

/**
 * @param {Record<string, unknown>} migrationConfig
 * @param {{ tableLabel: string, repairSpec?: RepairSpec | null }} options
 */
export function assertMigrateRunModeSupported(migrationConfig, options) {
  const mode = String(migrationConfig?.migrateRunMode ?? "full");
  if (mode !== "repair-from-log") return;
  if (!options.repairSpec) {
    throw new Error(
      `migrateRunMode=repair-from-log ไม่มี RepairSpec สำหรับ "${options.tableLabel}"`,
    );
  }
}

/**
 * @param {string} logsDir
 * @param {RegExp} pattern
 * @returns {string | null}
 */
export function findLatestLogFile(logsDir, pattern) {
  if (!fs.existsSync(logsDir)) return null;
  let best = null;
  let bestMtime = 0;
  for (const name of fs.readdirSync(logsDir)) {
    if (!pattern.test(name)) continue;
    const full = path.join(logsDir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.mtimeMs >= bestMtime) {
      bestMtime = st.mtimeMs;
      best = full;
    }
  }
  return best;
}

/**
 * @param {unknown} first
 * @param {unknown} last
 * @param {number} [maxExpand]
 * @returns {string[]}
 */
export function expandNumericIdRange(first, last, maxExpand = MAX_RANGE_EXPAND) {
  if (first == null || last == null) return [];
  const a = tryBigInt(first);
  const b = tryBigInt(last);
  if (a == null || b == null) return [String(first), String(last)];
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  const count = hi - lo + 1n;
  if (count > BigInt(maxExpand)) {
    console.error(
      `>>> repair: ช่วง ${lo}..${hi} กว้าง ${count} id — เก็บเฉพาะปลาย (${maxExpand} สูงสุด)`,
    );
    return [lo.toString(), hi.toString()];
  }
  /** @type {string[]} */
  const out = [];
  for (let i = lo; i <= hi; i++) out.push(i.toString());
  return out;
}

/**
 * @param {object} runLog
 * @param {Set<string>} idSet
 * @param {{ failedChunkIdFields: [string, string], listIdFields?: string[], bisectField?: string }} opts
 */
export function collectIdsFromRunLogCommon(runLog, idSet, opts) {
  const results = Array.isArray(runLog.tableResults)
    ? runLog.tableResults
    : [runLog];

  for (const r of results) {
    if (!r || typeof r !== "object") continue;
    for (const listField of opts.listIdFields ?? []) {
      const list = /** @type {unknown} */ (r)[listField];
      if (!Array.isArray(list)) continue;
      for (const id of list) {
        if (id != null && String(id).trim() !== "") idSet.add(String(id));
      }
    }
    for (const ch of r.chunkResults ?? []) {
      if (!ch || ch.status !== "failed") continue;
      const [firstKey, lastKey] = opts.failedChunkIdFields;
      const first = ch[firstKey];
      const last = ch[lastKey];
      for (const id of expandNumericIdRange(first, last)) idSet.add(id);
      if (opts.bisectField) {
        const bisect = ch[opts.bisectField];
        if (Array.isArray(bisect)) {
          for (const id of bisect) {
            if (id != null && String(id).trim() !== "") idSet.add(String(id));
          }
        }
      }
    }
  }

  const failure = runLog.failureContext;
  if (failure && typeof failure === "object") {
    const [firstKey, lastKey] = opts.failedChunkIdFields;
    for (const id of expandNumericIdRange(
      failure[firstKey],
      failure[lastKey],
    )) {
      idSet.add(id);
    }
    if (opts.bisectField) {
      const bisect = failure[opts.bisectField];
      if (Array.isArray(bisect)) {
        for (const id of bisect) {
          if (id != null && String(id).trim() !== "") idSet.add(String(id));
        }
      }
    }
  }
}

/**
 * @param {object} payload
 * @param {Set<string>} idSet
 * @param {string} recordIdKey
 */
export function collectIdsFromFieldIssueLogCommon(payload, idSet, recordIdKey) {
  const records = payload?.records;
  if (!records || typeof records !== "object") return;
  for (const key of Object.keys(records)) {
    if (key.trim() !== "") idSet.add(String(key));
  }
  if (Array.isArray(records)) {
    for (const rec of records) {
      const id = rec?.[recordIdKey];
      if (id != null && String(id).trim() !== "") idSet.add(String(id));
    }
  }
}

function tryBigInt(v) {
  try {
    return BigInt(String(v).trim());
  } catch {
    return null;
  }
}
