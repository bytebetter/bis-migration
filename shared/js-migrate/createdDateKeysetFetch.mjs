import {
  CREATED_DATE_SORT_KEY_VERSION,
  LEGACY_SORT_KEY_VERSION,
} from "./mssqlCreatedDateSort.mjs";

const COMPOSITE_START = Object.freeze({
  afterNullBucket: -1,
  afterCreatedDate: null,
  afterExamId: 0,
  afterChildId: 0,
});

function parseCreatedDateForBind(cd) {
  if (cd == null || String(cd).trim() === "") {
    return new Date("1900-01-01");
  }
  const d = new Date(String(cd));
  return Number.isNaN(d.getTime()) ? new Date("1900-01-01") : d;
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
      sqlLib.DateTime2,
      parseCreatedDateForBind(state.afterCreatedDate),
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
      sqlLib.DateTime2,
      parseCreatedDateForBind(state.afterCreatedDate),
    )
    .input("afterExamId", sqlLib.BigInt, state.afterExamId ?? 0);
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
      afterExamId,
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
