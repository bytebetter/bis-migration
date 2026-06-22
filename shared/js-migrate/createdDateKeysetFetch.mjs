import {
  CREATED_DATE_SORT_KEY_VERSION,
  LEGACY_SORT_KEY_VERSION,
} from "./mssqlCreatedDateSort.mjs";

/** @param {import("mssql").Request} req */
export function bindCreatedDateOrNumericKeyset(
  req,
  sqlLib,
  sortBundle,
  { mssqlKeysetAfter, numericAfter, numericParam = "afterExamId" },
) {
  if (sortBundle?.createdDateColumn) {
    req.input(
      "afterSortKey",
      sqlLib.NVarChar(sqlLib.MAX),
      mssqlKeysetAfter ?? "",
    );
    return "createdDate";
  }
  req.input(numericParam, sqlLib.BigInt, numericAfter);
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
  if (!rows?.length) return state;

  if (sortBundle?.createdDateColumn) {
    const last = rows[rows.length - 1];
    return {
      ...state,
      mssqlKeysetAfter:
        last?.[sortKeyField] ??
        last?.__mssql_sort_key ??
        state.mssqlKeysetAfter ??
        "",
    };
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
    const last = idRows[idRows.length - 1];
    return {
      ...state,
      mssqlKeysetAfter: last?.__mssql_sort_key ?? state.mssqlKeysetAfter ?? "",
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
  } = {},
) {
  const base = {
    offset,
    completed,
    updatedAt: new Date().toISOString(),
    sortKeyVersion:
      sortBundle?.sortKeyVersion ??
      (sortBundle?.createdDateColumn
        ? CREATED_DATE_SORT_KEY_VERSION
        : LEGACY_SORT_KEY_VERSION),
    ...extra,
  };
  if (sortBundle?.createdDateColumn) {
    return {
      ...base,
      mssqlKeysetAfter: mssqlKeysetAfter ?? "",
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
