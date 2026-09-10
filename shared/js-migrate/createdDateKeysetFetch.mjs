import {
  CREATED_DATE_SORT_KEY_VERSION,
  LEGACY_SORT_KEY_VERSION,
} from "./mssqlCreatedDateSort.mjs";
import { examIdOnlyCreatedDateWhereClause } from "./mssqlCreatedDateCompositeKeyset.mjs";
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
 * resume ผ่าน migrate:all (มี sourceCountCap): แผน = cap − offset แต่ offset ใน checkpoint เป็นตัวนับสะสม
 * ที่เพี้ยนได้ (เคยนับแถวที่อ่านซ้ำ / ต้นทางลบแถว) → cap ตัดแถวใหม่ท้ายตารางทุกรอบ
 * นับตำแหน่งจริงของที่คั่นหน้าจากต้นทาง (จำนวนแถวที่อยู่ก่อน/ที่ checkpoint) แล้วใช้ค่าที่น้อยกว่า
 * → แผนมีแต่เท่าเดิมหรือมากขึ้น ไม่มีทางอ่านน้อยลงกว่าเดิม
 * 1 query ต่อรอบ เฉพาะตอนมี cap + resume ในโหมด CreatedDate (query รายหน้าไม่เปลี่ยน)
 * @param {import("mssql").ConnectionPool} pool
 * @param {typeof import("mssql")} sqlLib
 * @param {{ tableLabel: string, sourceObjectNoLock: string, sortBundle: object, composite: object | null, offset: number, migrationConfig: object, indexLimited?: boolean }} p
 * @returns {Promise<number>}
 */
export async function reconcileCappedResumeOffset(pool, sqlLib, p) {
  const {
    tableLabel,
    sourceObjectNoLock,
    sortBundle,
    composite,
    offset,
    migrationConfig,
    indexLimited = false,
  } = p;
  if (!sortBundle?.createdDateColumn || composite == null) return offset;
  if (readSourceCountCap(migrationConfig) == null) return offset;
  const kb = readNumericSourceKeyBounds(migrationConfig);
  if (indexLimited || kb.min != null || kb.max != null) return offset;
  if (!(offset > 0) || !(Number(composite.afterNullBucket) >= 0)) return offset;

  const req = pool.request();
  bindExamIdCompositeKeyset(req, sqlLib, composite);
  const res = await req.query(`
SELECT
  COUNT_BIG(1) AS total_n,
  SUM(CASE WHEN ${examIdOnlyCreatedDateWhereClause(sortBundle.createdDateColumn)} THEN 1 ELSE 0 END) AS after_n
FROM ${sourceObjectNoLock};`);
  const total = Number(res.recordset?.[0]?.total_n);
  const after = Number(res.recordset?.[0]?.after_n ?? 0);
  if (!Number.isFinite(total) || !Number.isFinite(after)) return offset;
  const position = Math.max(0, total - after);
  if (position >= offset) return offset;
  console.error(
    `>>> [${tableLabel}] ปรับ offset ตามตำแหน่ง checkpoint ในต้นทาง: ${offset} → ${position} (กัน cap ตัดแถวใหม่ท้ายตาราง)`,
  );
  return position;
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
