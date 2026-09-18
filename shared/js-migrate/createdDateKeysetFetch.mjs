import {
  bracketMssqlIdent,
  CREATED_DATE_SORT_KEY_VERSION,
  LEGACY_SORT_KEY_VERSION,
} from "./mssqlCreatedDateSort.mjs";
import {
  examChildCreatedDateWhereClause,
  examChildLegacyWhereClause,
  examIdOnlyCreatedDateWhereClause,
} from "./mssqlCreatedDateCompositeKeyset.mjs";
import {
  bindMigrateSrcNumericRange,
  readNumericSourceKeyBounds,
} from "./migrateCliArgs.mjs";
import { readSourceCountCap } from "./sourceIndexRange.mjs";

const COMPOSITE_START = Object.freeze({
  afterNullBucket: -1,
  afterCreatedDate: null,
  afterExamId: 0,
  afterChildId: 0,
});

const CREATED_DATE_BIND_FLOOR = "1900-01-01T00:00:00";

/**
 * ค่า CreatedDate ของที่คั่นหน้า = ข้อความ ISO (style 126) ตามที่ SQL ส่งมา — ส่งกลับเป็นข้อความ
 * ให้ SQL แปลงเป็นชนิดของคอลัมน์เอง (param แปลง ไม่ใช่คอลัมน์ → ยังใช้ index ได้)
 * ห้ามผ่าน JS Date: ตีความเป็นเวลาเครื่อง (เพี้ยนตาม TZ) และ ms 3 หลักไม่ตรงกับ datetime (1/300 วินาที)
 * → เคยทำให้อ่านแถวรอยต่อหน้าซ้ำ (นับเกิน → cap ตัดท้าย) หรือข้ามแถวที่ CreatedDate เท่ากัน
 */
function createdDateBindValue(cd) {
  const s = cd == null ? "" : String(cd).trim();
  return s === "" ? CREATED_DATE_BIND_FLOOR : s;
}

/** @param {Record<string, unknown>} checkpoint @param {boolean} checkpointEnabled @param {boolean} sortKeyVersionUpgraded */
export function initExamChildCompositeKeysetFromCheckpoint(
  checkpoint,
  checkpointEnabled,
  sortKeyVersionUpgraded,
) {
  if (!checkpointEnabled || sortKeyVersionUpgraded) {
    return { ...COMPOSITE_START };
  }
  const afterNullBucket = Number(checkpoint.afterNullBucket ?? -1);
  return {
    afterNullBucket: Number.isFinite(afterNullBucket) ? afterNullBucket : -1,
    afterCreatedDate:
      checkpoint.afterCreatedDate == null
        ? null
        : String(checkpoint.afterCreatedDate),
    afterExamId: Number(checkpoint.afterExamId ?? 0) || 0,
    afterChildId: Number(checkpoint.afterChildId ?? 0) || 0,
  };
}

/** @param {import("mssql").Request} req @param {typeof import("mssql")} sqlLib @param {{ afterNullBucket?: number, afterCreatedDate?: string | null, afterExamId?: number, afterChildId?: number }} state */
export function bindExamChildCompositeKeyset(req, sqlLib, state) {
  req
    .input("afterNullBucket", sqlLib.Int, state.afterNullBucket ?? -1)
    .input(
      "afterCreatedDate",
      sqlLib.NVarChar(40),
      createdDateBindValue(state.afterCreatedDate),
    )
    .input("afterExamId", sqlLib.BigInt, state.afterExamId ?? 0)
    .input("afterChildId", sqlLib.Int, state.afterChildId ?? 0);
}

/** @param {import("mssql").Request} req @param {typeof import("mssql")} sqlLib @param {{ afterNullBucket?: number, afterCreatedDate?: string | null, afterExamId?: number }} state */
export function bindExamIdCompositeKeyset(req, sqlLib, state) {
  req
    .input("afterNullBucket", sqlLib.Int, state.afterNullBucket ?? -1)
    .input(
      "afterCreatedDate",
      sqlLib.NVarChar(40),
      createdDateBindValue(state.afterCreatedDate),
    )
    .input("afterExamId", sqlLib.BigInt, state.afterExamId ?? 0);
}

/**
 * จำนวนแถวทั้งหมด / แถวที่อยู่หลังที่คั่นหน้า (1 query)
 * แยก 2 query: COUNT ทั้งตาราง (แบบเดียวกับ snapshot count) ก่อน แล้วค่อยนับแถวหลังที่คั่นหน้า
 * — afterGuard อยู่ใน WHERE (เช่น [CreatedDate] >= @x) ให้ใช้ index อ่านเฉพาะแถวท้ายตาราง
 * — นับ total ก่อน: แถวที่เข้ามาระหว่างสอง query ทำให้ after มากขึ้น = อ่านเกิน ไม่ใช่อ่านขาด
 * @param {() => import("mssql").Request} newRequest
 * @param {{ fromSql: string, baseWhere?: string, afterPredicate: string, afterGuard?: string, bind: (req: import("mssql").Request) => void }} p
 * @returns {Promise<{ total: number, after: number }>}
 */
export async function countRowsAfterCursor(newRequest, p) {
  const { fromSql, baseWhere = "", afterPredicate, afterGuard = "", bind } = p;
  const whereOf = (parts) => {
    const list = parts.map((s) => String(s ?? "").trim()).filter(Boolean);
    return list.length ? `\nWHERE ${list.map((s) => `(${s})`).join("\n  AND ")}` : "";
  };
  const totalRes = await newRequest().query(
    `SELECT COUNT_BIG(1) AS n FROM ${fromSql}${whereOf([baseWhere])};`,
  );
  const req = newRequest();
  bind(req);
  const afterRes = await req.query(
    `SELECT COUNT_BIG(1) AS n FROM ${fromSql}${whereOf([baseWhere, afterGuard, afterPredicate])};`,
  );
  return {
    total: Number(totalRes.recordset?.[0]?.n),
    after: Number(afterRes.recordset?.[0]?.n ?? 0),
  };
}

/**
 * วันที่ขั้นต่ำของแถวที่อยู่หลังที่คั่นหน้า จาก sort key ข้อความรูปแบบ
 * '1' + 'yyyy-mm-ddThh:mi:ss.mmm' + '_' (mssqlCreatedDateSortTextExpr)
 * คืน null เมื่อที่คั่นหน้าอยู่กลุ่ม CreatedDate NULL / ว่าง / รูปแบบเก่า
 * @param {string | null | undefined} sortKey
 */
export function createdDateFloorFromSortKey(sortKey) {
  const m = /^1(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})_/.exec(
    String(sortKey ?? ""),
  );
  return m ? m[1] : null;
}

/**
 * ที่คั่นหน้า sort key ข้อความรุ่นเก่า (วันที่ style 126 ที่ตัด .000) → รุ่นใหม่ โดยไม่ข้ามและไม่อ่านซ้ำ
 * "อ่านแล้ว" = แถวที่ key เก่า <= ที่คั่นหน้าเดิม (ตรงกับที่โค้ดเก่าจะอ่านต่อด้วย key เก่า > ที่คั่นหน้า)
 * แถวอ่านแล้ว/ยังไม่อ่านที่อาจสลับลำดับกันมีได้แค่ในวินาทีของที่คั่นหน้าเป็นต้นไป → นับเฉพาะช่วงนั้น
 * - ปกติ (แถวยังไม่อ่านทุกแถวอยู่หลังแถวอ่านแล้วตาม key ใหม่) → ที่คั่นหน้าใหม่ = MAX(key ใหม่ ของแถวอ่านแล้ว)
 * - ถ้าสลับกัน → ถอยที่คั่นหน้ามาก่อนแถวยังไม่อ่านตัวแรก (อ่านซ้ำเฉพาะแถวที่เกินมา)
 * คืน null เมื่อที่คั่นหน้าเดิมอยู่กลุ่ม CreatedDate NULL (ผู้เรียกต้องเริ่มใหม่)
 *
 * readThroughCreatedDate: checkpoint เดิม completed (รอบนั้นอ่านครบทุกแถวในกลุ่ม CreatedDate ของที่คั่นหน้า
 * เพราะเรียง CreatedDate ก่อน) → "อ่านแล้ว" = CreatedDate <= วันที่ของที่คั่นหน้า (ตรงกับที่รอบนั้นอ่านจริง
 * แม่นกว่าเทียบ key เก่า ซึ่งลำดับข้อความในกลุ่มเดียวกันไม่ตรง ORDER BY เดิม)
 * @param {() => import("mssql").Request} newRequest
 * @param {typeof import("mssql")} sqlLib
 * @param {{ fromSql: string, createdDateColumn: string, oldKeyExpr: string, newKeyExpr: string, oldKey: string, baseWhere?: string, readThroughCreatedDate?: boolean }} p
 * @returns {Promise<{ key: string, exact: boolean } | null>}
 */
export async function convertTextSortKeyCheckpoint(newRequest, sqlLib, p) {
  const {
    fromSql,
    createdDateColumn,
    oldKeyExpr,
    newKeyExpr,
    oldKey,
    baseWhere = "",
    readThroughCreatedDate = false,
  } = p;
  const m = /^1((\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?)_/.exec(
    String(oldKey ?? ""),
  );
  if (!m) return null;
  const cd = bracketMssqlIdent(createdDateColumn);
  const base = String(baseWhere).trim() ? `(${baseWhere}) AND ` : "";
  const readPred = readThroughCreatedDate
    ? `${cd} <= @ckCreatedDate`
    : `${oldKeyExpr} <= @oldKey`;
  const unreadPred = readThroughCreatedDate
    ? `${cd} > @ckCreatedDate`
    : `${oldKeyExpr} > @oldKey`;
  const bindAll = (req, extra = {}) => {
    req
      .input("oldKey", sqlLib.NVarChar(sqlLib.MAX), String(oldKey))
      .input("ckCreatedDate", sqlLib.NVarChar(40), m[1])
      .input("ckSecond", sqlLib.NVarChar(40), m[2]);
    for (const [k, v] of Object.entries(extra)) {
      req.input(k, sqlLib.NVarChar(sqlLib.MAX), v);
    }
    return req;
  };
  // เทียบ max/min ใน SQL (collation เดียวกับ keyset `key > @afterSortKey`)
  const win = await bindAll(newRequest()).query(`
SELECT
  w.max_read,
  w.min_unread,
  CASE
    WHEN w.max_read IS NULL THEN 0
    WHEN w.min_unread IS NULL OR w.min_unread > w.max_read THEN 1
    ELSE 0
  END AS ordered
FROM (
  SELECT
    MAX(CASE WHEN ${readPred} THEN ${newKeyExpr} END) AS max_read,
    MIN(CASE WHEN ${unreadPred} THEN ${newKeyExpr} END) AS min_unread
  FROM ${fromSql}
  WHERE ${base}${cd} >= @ckSecond
) w;`);
  const row = win.recordset?.[0] ?? {};
  const maxRead = row.max_read ?? null;
  const minUnread = row.min_unread ?? null;
  if (maxRead != null && Number(row.ordered) === 1) {
    return { key: String(maxRead), exact: true };
  }
  // ถอยมาก่อนแถวยังไม่อ่านตัวแรก / ก่อนวินาทีของที่คั่นหน้า (แถวที่เกินจะถูกอ่านซ้ำ)
  const prev = await bindAll(newRequest(), {
    minUnread: minUnread == null ? "" : String(minUnread),
  }).query(`
SELECT COALESCE(
  (SELECT MAX(${newKeyExpr}) FROM ${fromSql}
   WHERE ${base}${cd} >= @ckSecond AND ${readPred}
     AND (@minUnread = N'' OR ${newKeyExpr} < @minUnread)),
  (SELECT MAX(${newKeyExpr}) FROM ${fromSql} WHERE ${base}${cd} < @ckSecond)
) AS k;`);
  const k = prev.recordset?.[0]?.k;
  // ไม่มีแถวก่อนหน้าเลย → เริ่มที่ต้นกลุ่มที่มีวันที่ ('1' น้อยกว่า key ทุกแถวที่มีวันที่)
  return { key: k == null ? "1" : String(k), exact: false };
}

/**
 * resume ผ่าน migrate:all (มี sourceCountCap): แผน = cap − offset แต่ offset ใน checkpoint เป็นตัวนับสะสม
 * ที่เพี้ยนได้ (เคยนับแถวที่อ่านซ้ำ / ต้นทางลบแถว) → cap ตัดแถวใหม่ท้ายตารางทุกรอบ
 * นับตำแหน่งจริงของที่คั่นหน้าจากต้นทาง (จำนวนแถวทั้งหมด − แถวที่อยู่หลังที่คั่นหน้า) แล้วใช้ค่าที่น้อยกว่า
 * → แผนมีแต่เท่าเดิมหรือมากขึ้น ไม่มีทางอ่านน้อยลงกว่าเดิม
 * 1 query ต่อรอบ เฉพาะตอนมี cap + มีที่คั่นหน้า (query รายหน้าไม่เปลี่ยน)
 *
 * afterPredicate ต้องเป็นเงื่อนไขเดียวกับ WHERE ของ query keyset ตารางนั้น
 * baseWhere ต้องตรงกับเงื่อนไขที่ snapshot count ใช้ (migrateSourceCountSql.mjs)
 * afterGuard (ถ้ามี) = เงื่อนไขถูกๆ ที่แถวหลังที่คั่นหน้าต้องผ่านเสมอ — กันคำนวณ afterPredicate ทั้งตาราง
 * @param {() => import("mssql").Request} newRequest
 * @param {{
 *   tableLabel: string,
 *   fromSql: string,
 *   baseWhere?: string,
 *   afterPredicate: string,
 *   afterGuard?: string,
 *   bind: (req: import("mssql").Request) => void,
 *   offset: number,
 *   migrationConfig: object,
 *   indexLimited?: boolean,
 * }} p
 * @returns {Promise<number>}
 */
export async function reconcileResumeOffsetByAfterCount(newRequest, p) {
  const { tableLabel, offset, migrationConfig, indexLimited = false } = p;
  if (!(offset > 0)) return offset;
  if (readSourceCountCap(migrationConfig) == null) return offset;
  const kb = readNumericSourceKeyBounds(migrationConfig);
  if (indexLimited || kb.min != null || kb.max != null) return offset;

  const { total, after } = await countRowsAfterCursor(newRequest, p);
  if (!Number.isFinite(total) || !Number.isFinite(after)) return offset;
  const position = Math.max(0, total - after);
  if (position >= offset) return offset;
  console.error(
    `>>> [${tableLabel}] ปรับ offset ตามตำแหน่ง checkpoint ในต้นทาง: ${offset} → ${position} (กัน cap ตัดแถวใหม่ท้ายตาราง)`,
  );
  return position;
}

/**
 * ที่คั่นหน้าอยู่กลุ่มที่มีวันที่แล้ว → แถวหลังที่คั่นหน้าทุกแถวมี CreatedDate >= วันที่ของที่คั่นหน้า
 * (กลุ่ม NULL ยังต้องนับทั้งตาราง เพราะแถวที่มีวันที่ทุกแถวอยู่หลังกลุ่ม NULL)
 */
function compositeCreatedDateGuard(sortBundle, composite) {
  if (Number(composite?.afterNullBucket) !== 1) return "";
  return `${bracketMssqlIdent(sortBundle.createdDateColumn)} >= @afterCreatedDate`;
}

/**
 * ตัวปรับ offset ของตารางระดับ exam (examination / billing / examination_general / ultrasound / mammogram)
 * โหมด CreatedDate ใช้ composite keyset; ไม่มี CreatedDate ใช้ [Exam_ID] > @afterExamId
 * @param {import("mssql").ConnectionPool} pool
 * @param {typeof import("mssql")} sqlLib
 * @param {{ tableLabel: string, sourceObjectNoLock: string, sortBundle: object, composite: object | null, afterExamId?: number | bigint | null, offset: number, migrationConfig: object, indexLimited?: boolean }} p
 * @returns {Promise<number>}
 */
export async function reconcileCappedResumeOffset(pool, sqlLib, p) {
  const {
    tableLabel,
    sourceObjectNoLock,
    sortBundle,
    composite,
    afterExamId = null,
    offset,
    migrationConfig,
    indexLimited = false,
  } = p;
  const common = {
    tableLabel,
    fromSql: sourceObjectNoLock,
    offset,
    migrationConfig,
    indexLimited,
  };
  if (sortBundle?.createdDateColumn) {
    if (composite == null || !(Number(composite.afterNullBucket) >= 0)) {
      return offset;
    }
    return reconcileResumeOffsetByAfterCount(() => pool.request(), {
      ...common,
      afterPredicate: examIdOnlyCreatedDateWhereClause(
        sortBundle.createdDateColumn,
      ),
      afterGuard: compositeCreatedDateGuard(sortBundle, composite),
      bind: (req) => bindExamIdCompositeKeyset(req, sqlLib, composite),
    });
  }
  if (afterExamId == null) return offset;
  const after = BigInt(String(afterExamId));
  if (after < 0n) return offset;
  return reconcileResumeOffsetByAfterCount(() => pool.request(), {
    ...common,
    afterPredicate: "[Exam_ID] > @afterExamId",
    bind: (req) => req.input("afterExamId", sqlLib.BigInt, after),
  });
}

/**
 * ตัวปรับ offset ของตารางลูก (Exam_ID + child id) — mammogram_cal/mass, ultrasound_cyst/mass, procedure
 * @param {import("mssql").ConnectionPool} pool
 * @param {typeof import("mssql")} sqlLib
 * @param {{ tableLabel: string, sourceObjectNoLock: string, sortBundle: object, childColumn: string, keyExprs?: import("./mssqlCreatedDateCompositeKeyset.mjs").ExamChildKeyExprs, composite: object | null, afterExamId: number, afterChildId: number, offset: number, migrationConfig: object, indexLimited?: boolean }} p
 * @returns {Promise<number>}
 */
export async function reconcileExamChildResumeOffset(pool, sqlLib, p) {
  const {
    tableLabel,
    sourceObjectNoLock,
    sortBundle,
    childColumn,
    keyExprs,
    composite,
    afterExamId,
    afterChildId,
    offset,
    migrationConfig,
    indexLimited = false,
  } = p;
  const common = {
    tableLabel,
    fromSql: sourceObjectNoLock,
    offset,
    migrationConfig,
    indexLimited,
  };
  if (sortBundle?.createdDateColumn) {
    if (composite == null || !(Number(composite.afterNullBucket) >= 0)) {
      return offset;
    }
    return reconcileResumeOffsetByAfterCount(() => pool.request(), {
      ...common,
      afterPredicate: examChildCreatedDateWhereClause(
        sortBundle.createdDateColumn,
        childColumn,
        keyExprs,
      ),
      afterGuard: compositeCreatedDateGuard(sortBundle, composite),
      bind: (req) => bindExamChildCompositeKeyset(req, sqlLib, composite),
    });
  }
  return reconcileResumeOffsetByAfterCount(() => pool.request(), {
    ...common,
    afterPredicate: examChildLegacyWhereClause(childColumn, keyExprs),
    bind: (req) =>
      req
        .input("afterExamId", sqlLib.BigInt, afterExamId ?? 0)
        .input("afterChildId", sqlLib.Int, afterChildId ?? 0),
  });
}

/**
 * ดึง keyset หนึ่งหน้าสำหรับตารางลูก (Exam_ID + child)
 * สลับ bucket CreatedDate NULL→มีวันที่ เมื่อ bucket 0 หมดแล้ว
 */
export async function queryExamChildKeysetPage(
  pool,
  sqlLib,
  migrationConfig,
  sortBundle,
  { keysetSql, compositeKs, afterExamId, afterChildId, pageSize },
) {
  let state = { ...compositeKs };
  const run = async () => {
    const keysetReq = pool.request();
    bindMigrateSrcNumericRange(keysetReq, migrationConfig, sqlLib);
    if (sortBundle.createdDateColumn) {
      bindExamChildCompositeKeyset(keysetReq, sqlLib, state);
    } else {
      keysetReq
        .input("afterExamId", sqlLib.BigInt, afterExamId)
        .input("afterChildId", sqlLib.Int, afterChildId);
    }
    const res = await keysetReq
      .input("page", sqlLib.Int, pageSize)
      .query(keysetSql);
    return res.recordset || [];
  };

  let rows = await run();
  if (
    rows.length === 0 &&
    sortBundle.createdDateColumn &&
    state.afterNullBucket === 0
  ) {
    state = {
      afterNullBucket: 1,
      afterCreatedDate: null,
      afterExamId: 0,
      afterChildId: 0,
    };
    rows = await run();
  }
  return { rows, compositeKs: state };
}

/** รีเซ็ต checkpoint เมื่อสลับจาก CreatedDate composite → legacy Exam_ID+child */
export function reconcileLegacyExamChildCheckpoint({
  sortBundle,
  checkpoint,
  checkpointEnabled,
}) {
  let offset = Number(checkpointEnabled ? checkpoint.offset : 0);
  let afterExamId = Number(checkpoint.afterExamId ?? 0);
  let afterChildId = Number(checkpoint.afterChildId ?? 0);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  if (!Number.isFinite(afterExamId) || afterExamId < 0) afterExamId = 0;
  if (!Number.isFinite(afterChildId) || afterChildId < 0) afterChildId = 0;

  if (!checkpointEnabled || sortBundle?.createdDateColumn) {
    return { offset, afterExamId, afterChildId, reset: false };
  }
  const v = Number(checkpoint.sortKeyVersion ?? LEGACY_SORT_KEY_VERSION);
  if (v >= CREATED_DATE_SORT_KEY_VERSION) {
    return { offset: 0, afterExamId: 0, afterChildId: 0, reset: true };
  }
  return { offset, afterExamId, afterChildId, reset: false };
}

/** @param {object | undefined} lastRow @param {string} childIdField */
export function advanceExamChildCompositeKeyset(lastRow, childIdField) {
  if (!lastRow) return { ...COMPOSITE_START, afterNullBucket: 0 };
  const cdRaw = lastRow.__created_date_mssql;
  const hasDate = cdRaw != null && String(cdRaw).trim() !== "";
  const examId = Number.parseInt(String(lastRow.exam_id ?? "").trim(), 10);
  const childId = Number.parseInt(String(lastRow[childIdField] ?? "").trim(), 10);
  return {
    afterNullBucket: hasDate ? 1 : 0,
    afterCreatedDate: hasDate ? String(cdRaw).trim() : null,
    afterExamId: Number.isFinite(examId) ? examId : 0,
    afterChildId: Number.isFinite(childId) ? childId : 0,
  };
}

/** @param {object | undefined} lastRow */
export function advanceExamIdCompositeKeyset(lastRow) {
  if (!lastRow) return { afterNullBucket: 0, afterCreatedDate: null, afterExamId: 0 };
  const cdRaw = lastRow.__created_date_mssql;
  const hasDate = cdRaw != null && String(cdRaw).trim() !== "";
  const examId = Number.parseInt(
    String(lastRow.exam_id ?? lastRow.probe_exam_id ?? "").trim(),
    10,
  );
  return {
    afterNullBucket: hasDate ? 1 : 0,
    afterCreatedDate: hasDate ? String(cdRaw).trim() : null,
    afterExamId: Number.isFinite(examId) ? examId : 0,
  };
}

/** @param {{ afterNullBucket?: number, afterCreatedDate?: string | null, afterExamId?: number, afterChildId?: number }} state */
export function compositeKeysetCheckpointExtra(state) {
  return {
    afterNullBucket: state.afterNullBucket ?? -1,
    afterCreatedDate: state.afterCreatedDate ?? null,
    afterExamId: state.afterExamId ?? 0,
    afterChildId: state.afterChildId ?? 0,
  };
}

/** bind keyset แบบ sortKeyExpr (patient_info, appointment/schedule) */
export function bindSortKeyExprKeyset(req, sqlLib, mssqlKeysetAfter) {
  req.input(
    "afterSortKey",
    sqlLib.NVarChar(sqlLib.MAX),
    String(mssqlKeysetAfter ?? ""),
  );
}

/** @param {object[]} rows */
export function advanceSortKeyExprFromRows(rows, current = "") {
  if (!rows?.length) return current;
  const last = rows[rows.length - 1];
  return last?.__mssql_sort_key ?? current;
}

/** @param {import("mssql").Request} req */
export function bindCreatedDateOrNumericKeyset(
  req,
  sqlLib,
  sortBundle,
  state,
) {
  if (sortBundle?.createdDateColumn) {
    const composite =
      state?.composite ??
      state?.compositeState ??
      initExamChildCompositeKeysetFromCheckpoint(
        {
          afterNullBucket: state?.afterNullBucket,
          afterCreatedDate: state?.afterCreatedDate,
          afterExamId: state?.afterExamId ?? state?.numericAfter,
          afterChildId: state?.afterChildId,
        },
        true,
        false,
      );
    if (composite.afterChildId != null && composite.afterChildId > 0) {
      bindExamChildCompositeKeyset(req, sqlLib, composite);
    } else {
      bindExamIdCompositeKeyset(req, sqlLib, composite);
    }
    return "createdDateComposite";
  }
  const numericParam = state?.numericParam ?? "afterExamId";
  req.input(numericParam, sqlLib.BigInt, state.numericAfter);
  return "numeric";
}

/**
 * @param {object[]} rows
 * @param {object} sortBundle
 * @param {{ mssqlKeysetAfter?: string | null, numericAfter?: number | bigint }} state
 * @param {{ numericField?: string, sortKeyField?: string }} [opts]
 */
export function advanceCreatedDateKeysetState(
  rows,
  sortBundle,
  state,
  opts = {},
) {
  const numericField = opts.numericField ?? "exam_id";
  const sortKeyField = opts.sortKeyField ?? "__mssql_sort_key";
  const childIdField = opts.childIdField ?? null;
  if (!rows?.length) return state;

  if (sortBundle?.createdDateColumn) {
    const last = rows[rows.length - 1];
    if (childIdField) {
      return {
        ...state,
        composite: advanceExamChildCompositeKeyset(last, childIdField),
      };
    }
    if (last?.__created_date_mssql != null) {
      return {
        ...state,
        composite: advanceExamIdCompositeKeyset(last),
      };
    }
    return state;
  }

  const raw = rows[rows.length - 1]?.[numericField];
  const parsed = Number.parseInt(String(raw ?? "").trim(), 10);
  return {
    ...state,
    mssqlKeysetAfter: null,
    numericAfter: Number.isFinite(parsed) ? parsed : state.numericAfter,
  };
}

/** @param {object[]} idRows rows จาก probe (อาจมี __mssql_sort_key) */
export function advanceCreatedDateKeysetFromProbe(
  idRows,
  sortBundle,
  state,
) {
  if (!idRows?.length) return state;
  if (sortBundle?.createdDateColumn) {
    return {
      ...state,
      composite: advanceExamIdCompositeKeyset(idRows[idRows.length - 1]),
    };
  }
  const raw = idRows[idRows.length - 1]?.exam_id ?? idRows[idRows.length - 1]?.probe_exam_id;
  const parsed = Number.parseInt(String(raw ?? "").trim(), 10);
  return {
    ...state,
    numericAfter: Number.isFinite(parsed) ? parsed : state.numericAfter,
  };
}

export function buildCreatedDateCheckpointFields(
  sortBundle,
  {
    offset = 0,
    mssqlKeysetAfter = "",
    afterExamId = 0,
    afterScheduleId = null,
    completed = false,
    extra = {},
    composite = null,
  } = {},
) {
  const compositeExtra =
    composite != null ? compositeKeysetCheckpointExtra(composite) : {};
  const base = {
    offset,
    completed,
    updatedAt: new Date().toISOString(),
    sortKeyVersion:
      sortBundle?.sortKeyVersion ??
      (sortBundle?.createdDateColumn
        ? CREATED_DATE_SORT_KEY_VERSION
        : LEGACY_SORT_KEY_VERSION),
    ...compositeExtra,
    ...extra,
  };
  if (sortBundle?.createdDateColumn) {
    return {
      ...base,
      mssqlKeysetAfter: mssqlKeysetAfter ?? "",
      // composite = ที่คั่นหน้าจริงของโหมด CreatedDate — param afterExamId (default 0) ต้องไม่ทับ
      // ไม่งั้น resume ได้ Exam_ID > 0 = อ่านซ้ำ/เริ่ม bucket NULL ใหม่ทั้งหมด
      afterExamId: composite != null ? compositeExtra.afterExamId : afterExamId,
    };
  }
  if (afterScheduleId != null) {
    return {
      ...base,
      mssqlKeysetAfter: null,
      afterScheduleId,
    };
  }
  return {
    ...base,
    mssqlKeysetAfter: null,
    afterExamId,
  };
}
