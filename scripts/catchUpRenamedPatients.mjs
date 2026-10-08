/**
 * เก็บตก patient_info: ต้นทางเปลี่ยน PID ในแถวเดิม (PID ชั่วคราว T… → เลขจริง เช่น T7525 → 208848)
 *
 * CreatedDate คงเดิมหลังเปลี่ยน PID → แถวอยู่ก่อน checkpoint รอบปกติไม่อ่าน แล้วเก็บตกเห็น PID ใหม่ว่า "ขาด"
 * ถ้า insert ตรงๆ Postgres ได้คนเดียวกัน 2 แถว และข้อมูลที่ผูกกับแถวเดิม (นัดที่จองด้วย PID T) ค้างอยู่กับแถวเก่า
 * → เปลี่ยน pid / old_db_id ของแถวเดิมแทน (คง id — ข้อมูลที่ผูกไว้ตามมา, ฟิลด์อื่นที่แก้ในระบบใหม่ไม่ถูกทับ)
 *
 * จับคู่ PID ใหม่กับแถวเดิม 2 ทาง:
 * 1. log ต้นทาง PACS_SYNC_PATIENT (OldPID → PID) + วันเกิดตรง + ชื่อหรือนามสกุลตรง
 *    จำเป็นเพราะต้นทางเอาเลข T ที่ว่างแล้วไปให้คนใหม่ได้ (T8288 → 208857 แล้ว T8288 เป็นของอีกคน)
 *    → PID เดิมยังอยู่ในต้นทางแต่เป็นคนละคน; หลังเปลี่ยนแถวเดิมแล้วต้อง insert คนใหม่ของเลขนั้น (reinsertPids)
 * 2. ไม่มีใน log: แถวที่ PID หายจากต้นทางแล้ว + ชื่อ นามสกุล วันเกิดตรงกันแบบ 1 ต่อ 1
 * กำกวม / เลขบัตรไม่ตรง / มี placeholder ของ PID ใหม่อยู่แล้ว → ไม่แตะ ปล่อยให้ --source-ids insert ตามเดิม
 */
import { PLACEHOLDER_FIRST_NAME_TH } from "../shared/js-migrate/ensurePlaceholderPatientInfo.mjs";
import { mapPatientInfoIdentity } from "../patient-info/js-migrate/patientInfoMapping.mjs";

const MSSQL_PARAM_CHUNK = 500;
const PID_TRIM_SQL = "LTRIM(RTRIM(CAST([PID] AS NVARCHAR(4000))))";

/** ครบทั้งชื่อ นามสกุล วันเกิด — ขาดตัวใดตัวหนึ่งถือว่าอ่อนเกินจะจับคู่ */
function hasIdentity(x) {
  return Boolean(x.first_name_th && x.last_name_th && x.date_of_birth);
}

function identityKey(x) {
  return `${x.first_name_th}\u0001${x.last_name_th}\u0001${x.date_of_birth}`;
}

const lowerTrim = (v) => (v == null ? "" : String(v).trim().toLowerCase());

function candidatePids(c) {
  return [lowerTrim(c.pid), lowerTrim(c.old_db_id)].filter((v) => v !== "");
}

/**
 * จับคู่ PID ใหม่ (ต้นทาง) กับแถวเดิม (Postgres)
 * @param {{ pid: string, first_name_th: string|null, last_name_th: string|null, date_of_birth: string|null, soc_id: string|null }[]} sources PID ที่ขาด
 * @param {{ id: number, pid: string|null, old_db_id: string|null, first_name_th: string|null, last_name_th: string|null, date_of_birth: string|null, soc_id: string|null, stale: boolean }[]} candidates
 *   แถว Postgres (ไม่ใช่ placeholder) ที่ identity ตรง หรือ PID อยู่ใน log; stale = PID ไม่อยู่ในต้นทางแล้ว
 * @param {{ blockedPids?: Set<string>, renameLog?: Map<string, Set<string>> }} [opts]
 *   blockedPids = PID ใหม่ (lower) ที่มี placeholder แล้ว, renameLog = PID ใหม่ (lower) → PID เดิม (lower) จาก PACS_SYNC_PATIENT
 */
export function pairRenamedPatients(sources, candidates, opts = {}) {
  const blockedPids = opts.blockedPids ?? new Set();
  const renameLog = opts.renameLog ?? new Map();
  const withIdentity = sources.filter(hasIdentity);
  const sourcesPerIdentity = new Map();
  for (const s of withIdentity) {
    const k = identityKey(s);
    sourcesPerIdentity.set(k, (sourcesPerIdentity.get(k) ?? 0) + 1);
  }

  /** @type {Map<number, { id: number, oldPid: string|null, newPid: string, via: string, oldPidAlive: boolean }>} */
  const byCandidate = new Map();
  const conflicted = new Set();
  const skipped = [];
  for (const s of withIdentity) {
    const logged = renameLog.get(lowerTrim(s.pid)) ?? new Set();
    const viaLog = candidates.filter(
      (c) =>
        candidatePids(c).some((p) => logged.has(p)) &&
        c.date_of_birth === s.date_of_birth &&
        (c.first_name_th === s.first_name_th || c.last_name_th === s.last_name_th),
    );
    let pick = null;
    let via = "";
    if (viaLog.length > 1) {
      skipped.push({ reason: "log ชี้หลายแถว", newPids: [s.pid], oldIds: viaLog.map((c) => c.id) });
      continue;
    } else if (viaLog.length === 1) {
      [pick] = viaLog;
      via = "log PACS_SYNC_PATIENT";
    } else {
      const stale = candidates.filter((c) => c.stale && identityKey(c) === identityKey(s));
      if (stale.length === 0) continue;
      if (stale.length > 1 || sourcesPerIdentity.get(identityKey(s)) > 1) {
        skipped.push({ reason: "ชื่อ/วันเกิดซ้ำหลายคน", newPids: [s.pid], oldIds: stale.map((c) => c.id) });
        continue;
      }
      [pick] = stale;
      via = "ชื่อ+วันเกิด";
    }
    if (s.soc_id && pick.soc_id && s.soc_id !== pick.soc_id) {
      skipped.push({ reason: "เลขบัตรไม่ตรง", newPids: [s.pid], oldIds: [pick.id] });
      continue;
    }
    if (blockedPids.has(lowerTrim(s.pid))) {
      skipped.push({ reason: "มี placeholder ของ PID ใหม่อยู่แล้ว", newPids: [s.pid], oldIds: [pick.id] });
      continue;
    }
    if (conflicted.has(pick.id)) continue;
    const prev = byCandidate.get(pick.id);
    if (prev) {
      // แถวเดิมเดียวถูกชี้จาก PID ใหม่ 2 ตัว — ไม่เลือกให้
      byCandidate.delete(pick.id);
      conflicted.add(pick.id);
      skipped.push({ reason: "PID ใหม่หลายตัวชี้แถวเดิมเดียวกัน", newPids: [prev.newPid, s.pid], oldIds: [pick.id] });
      continue;
    }
    byCandidate.set(pick.id, { id: pick.id, oldPid: pick.pid, newPid: s.pid, via, oldPidAlive: !pick.stale });
  }
  return { pairs: [...byCandidate.values()], skipped };
}

function paramList(n) {
  return Array.from({ length: n }, (_, j) => `@p${j}`).join(", ");
}

/** query MSSQL ทีละก้อน (จำกัดจำนวนพารามิเตอร์ต่อ request) */
async function queryByPids(pool, sqlPkg, pids, buildSql) {
  const rows = [];
  for (let i = 0; i < pids.length; i += MSSQL_PARAM_CHUNK) {
    const part = pids.slice(i, i + MSSQL_PARAM_CHUNK);
    const req = pool.request();
    part.forEach((p, j) => req.input(`p${j}`, sqlPkg.NVarChar(4000), p));
    const r = await req.query(buildSql(paramList(part.length)));
    rows.push(...(r.recordset ?? []));
  }
  return rows;
}

/**
 * log การเปลี่ยน PID: PID ใหม่ (lower) → PID เดิม (lower)
 * อ่านไม่ได้ (ไม่มีตาราง/สิทธิ์) → ใช้แค่การจับคู่ด้วยชื่อ+วันเกิด
 */
async function loadRenameLog(pool, sqlPkg, renameLogObj, pids, log) {
  /** @type {Map<string, Set<string>>} */
  const m = new Map();
  if (!renameLogObj) return m;
  try {
    const rows = await queryByPids(
      pool,
      sqlPkg,
      pids,
      (params) =>
        `SELECT DISTINCT LTRIM(RTRIM(CAST([OldPID] AS NVARCHAR(4000)))) AS old_pid, ${PID_TRIM_SQL} AS pid
         FROM ${renameLogObj}
         WHERE ${PID_TRIM_SQL} IN (${params}) AND [OldPID] IS NOT NULL`,
    );
    for (const r of rows) {
      const from = lowerTrim(r.old_pid);
      const to = lowerTrim(r.pid);
      if (from === "" || from === to) continue;
      if (!m.has(to)) m.set(to, new Set());
      m.get(to).add(from);
    }
  } catch (err) {
    log(`อ่าน log เปลี่ยน PID ไม่ได้ (${err instanceof Error ? err.message : err}) — จับคู่ด้วยชื่อ+วันเกิดอย่างเดียว`);
  }
  return m;
}

/**
 * @param {{
 *   pool: any, sqlPkg: any, client: import("pg").Client, srcObj: string, renameLogObj?: string | null,
 *   sourceKeys: Set<string>, missingPids: string[], dryRun: boolean, log: (line: string) => void,
 * }} p sourceKeys = PID ต้นทาง ณ snapshot (lower), missingPids = PID ที่ขาด (ตัวพิมพ์ตามต้นทาง)
 * @returns {Promise<{ relinked: string[], reinsertPids: string[], skipped: object[] }>}
 *   relinked = PID ใหม่ที่ผูกกับแถวเดิมแล้ว, reinsertPids = PID เดิมที่ต้นทางให้คนใหม่ไปแล้ว → ต้อง insert คนใหม่
 */
export async function relinkRenamedPatients(p) {
  const { pool, sqlPkg, client, srcObj, renameLogObj, sourceKeys, missingPids, dryRun, log } = p;
  const none = { relinked: [], reinsertPids: [], skipped: [] };
  if (missingPids.length === 0) return none;

  const sources = (
    await queryByPids(
      pool,
      sqlPkg,
      missingPids,
      (params) =>
        `SELECT CAST([PID] AS NVARCHAR(MAX)) AS pid,
                CAST([Name] AS NVARCHAR(MAX)) AS [name],
                CAST([Surname] AS NVARCHAR(MAX)) AS surname,
                CONVERT(VARCHAR(30), [DateOfBirth], 126) AS date_of_birth_be,
                CAST([SocID] AS NVARCHAR(MAX)) AS soc_id
         FROM ${srcObj}
         WHERE ${PID_TRIM_SQL} IN (${params})`,
    )
  )
    .map((row) => mapPatientInfoIdentity(row))
    .filter((s) => s.pid != null && hasIdentity(s));
  if (sources.length === 0) return none;

  const renameLog = await loadRenameLog(pool, sqlPkg, renameLogObj, sources.map((s) => s.pid), log);
  const loggedOldPids = [...new Set([...renameLog.values()].flatMap((s) => [...s]))];

  const { rows: found } = await client.query(
    `SELECT p.id, p.pid::text AS pid, p.old_db_id::text AS old_db_id,
            p.first_name_th, p.last_name_th, left(p.date_of_birth::text, 10) AS date_of_birth,
            p.soc_id::text AS soc_id
     FROM public.patient_info p
     WHERE COALESCE(p.first_name_th, '') <> $5
       AND (
         EXISTS (
           SELECT 1 FROM unnest($1::text[], $2::text[], $3::text[]) AS m(f, l, d)
           WHERE p.first_name_th = m.f AND p.last_name_th = m.l AND left(p.date_of_birth::text, 10) = m.d
         )
         OR lower(btrim(p.pid::text)) = ANY($4::text[])
         OR lower(btrim(p.old_db_id::text)) = ANY($4::text[])
       )`,
    [
      sources.map((s) => s.first_name_th),
      sources.map((s) => s.last_name_th),
      sources.map((s) => s.date_of_birth),
      loggedOldPids,
      PLACEHOLDER_FIRST_NAME_TH,
    ],
  );
  const missingLower = new Set(sources.map((s) => lowerTrim(s.pid)));
  const candidates = found.filter(
    (c) => candidatePids(c).length > 0 && !candidatePids(c).some((v) => missingLower.has(v)),
  );
  if (candidates.length === 0) return none;

  // PID ของแถวเดิมยังมีในต้นทางตอนนี้ไหม (เช็คสด — ไฟล์ key เป็นภาพ ณ snapshot)
  const checkPids = [...new Set(candidates.flatMap((c) => [c.pid, c.old_db_id]).filter((v) => v != null && v.trim() !== "").map((v) => v.trim()))];
  const live = new Set(
    (await queryByPids(pool, sqlPkg, checkPids, (params) =>
      `SELECT ${PID_TRIM_SQL} AS pid FROM ${srcObj} WHERE ${PID_TRIM_SQL} IN (${params})`,
    )).map((r) => lowerTrim(r.pid)),
  );
  for (const c of candidates) {
    c.stale = candidatePids(c).every((v) => !sourceKeys.has(v) && !live.has(v));
  }

  const { rows: ph } = await client.query(
    `SELECT lower(btrim(pid::text)) AS a, lower(btrim(old_db_id::text)) AS b
     FROM public.patient_info
     WHERE COALESCE(first_name_th, '') = $2
       AND (lower(btrim(pid::text)) = ANY($1::text[]) OR lower(btrim(old_db_id::text)) = ANY($1::text[]))`,
    [[...missingLower], PLACEHOLDER_FIRST_NAME_TH],
  );
  const blockedPids = new Set(ph.flatMap((r) => [r.a, r.b]).filter(Boolean));

  const { pairs, skipped } = pairRenamedPatients(sources, candidates, { blockedPids, renameLog });
  for (const s of skipped) {
    log(`ไม่เปลี่ยน PID (${s.reason}): PID ใหม่ ${s.newPids.join(", ")} / patient_info.id ${s.oldIds.join(", ")} — insert แถวใหม่ตามเดิม`);
  }
  if (pairs.length === 0) return { ...none, skipped };

  if (!dryRun) {
    await client.query("BEGIN");
    try {
      for (const x of pairs) {
        await client.query(`UPDATE public.patient_info SET pid = $2, old_db_id = $2 WHERE id = $1`, [x.id, x.newPid]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  }
  const reinsertPids = [];
  for (const x of pairs) {
    const reuse = x.oldPidAlive && x.oldPid != null;
    if (reuse) reinsertPids.push(x.oldPid.trim());
    log(
      `${dryRun ? "(dry-run) จะ" : ""}เปลี่ยน PID แถวเดิม: ${x.oldPid} → ${x.newPid} (patient_info.id ${x.id}, จับคู่ด้วย ${x.via})` +
        (reuse ? ` — ต้นทางให้ ${x.oldPid} กับคนใหม่แล้ว → เติมคนใหม่` : ""),
    );
  }
  return dryRun ? { ...none, skipped } : { relinked: pairs.map((x) => x.newPid), reinsertPids, skipped };
}
