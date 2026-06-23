import {
  buildCreatedDateSortExprs,
  MSSQL_EXAM_ID_ORDER_BY,
  MSSQL_EXAM_ID_SORT_KEY_EXPR,
  mssqlExamIdWithIntColumnOrderBy,
  mssqlExamIdWithIntColumnSortKeyExpr,
  mssqlIntColumnSortKeyExpr,
  bracketMssqlIdent,
} from "./mssqlCreatedDateSort.mjs";
import {
  createdDateSelectExpr,
  examChildCreatedDateOrderBy,
  examChildCreatedDateWhereClause,
  examIdOnlyCreatedDateOrderBy,
  examIdOnlyCreatedDateWhereClause,
} from "./mssqlCreatedDateCompositeKeyset.mjs";

/**
 * two-step fetch (probe Exam_ID → detail IN) พร้อม CreatedDate sort
 * @param {{ createdDateColumn?: string | null, detailColumns: string, keyRangeWhere?: string }} opts
 */
export function buildExamTwoStepSelectBundle({
  createdDateColumn,
  detailColumns,
  keyRangeWhere = "",
}) {
  const sort = buildCreatedDateSortExprs({
    createdDateColumn,
    tiebreakerOrderBy: MSSQL_EXAM_ID_ORDER_BY,
    tiebreakerSortKeyExpr: MSSQL_EXAM_ID_SORT_KEY_EXPR,
  });

  const keyRangeClause = keyRangeWhere
    ? `\n  AND (${keyRangeWhere.trim()})`
    : "";

  const idProbeLegacy = `
SELECT CAST(s.[Exam_ID] AS BIGINT) AS exam_id
FROM (
  SELECT TOP (@page)
    [Exam_ID]
  FROM {{sourceObject}}
  WHERE [Exam_ID] > @afterExamId${keyRangeClause}
  ORDER BY ${MSSQL_EXAM_ID_ORDER_BY}
) s`.trim();

  const idProbeCreatedDate = `
SELECT TOP (@page)
  CAST([Exam_ID] AS BIGINT) AS exam_id,
  ${createdDateSelectExpr(sort.createdDateColumn)}
FROM {{sourceObject}}
WHERE ${examIdOnlyCreatedDateWhereClause(sort.createdDateColumn)}${keyRangeClause}
ORDER BY ${examIdOnlyCreatedDateOrderBy(sort.createdDateColumn)}`.trim();

  const keysetSingleLegacy = `
SELECT TOP (@page)
${detailColumns}
FROM {{sourceObject}}
WHERE [Exam_ID] > @afterExamId${keyRangeClause}
ORDER BY ${MSSQL_EXAM_ID_ORDER_BY}`.trim();

  const keysetSingleCreatedDate = `
SELECT TOP (@page)
${detailColumns},
  ${createdDateSelectExpr(sort.createdDateColumn)}
FROM {{sourceObject}}
WHERE ${examIdOnlyCreatedDateWhereClause(sort.createdDateColumn)}${keyRangeClause}
ORDER BY ${examIdOnlyCreatedDateOrderBy(sort.createdDateColumn)}`.trim();

  const detailByIds = `
SELECT
${detailColumns}
FROM {{sourceObject}}
WHERE CAST([Exam_ID] AS BIGINT) IN ({{idPlaceholders}})
ORDER BY ${sort.orderBy}`.trim();

  const useCreatedDate = sort.createdDateColumn != null;

  return {
    ...sort,
    idProbeSql: useCreatedDate ? idProbeCreatedDate : idProbeLegacy,
    keysetSingleSql: useCreatedDate
      ? keysetSingleCreatedDate
      : keysetSingleLegacy,
    detailByIdsSql: detailByIds,
  };
}

/**
 * keyset แถวละ (Exam_ID, child int column) — mam_mass, mam_cal, ultrasound_*
 * @param {{ createdDateColumn?: string | null, selectColumns: string, legacySelectColumns?: string, stagingColumns: string, childColumn: string, keyRangeWhere?: string }} opts
 */
export function buildExamChildKeysetSelectBundle({
  createdDateColumn,
  selectColumns,
  legacySelectColumns = selectColumns,
  stagingColumns,
  childColumn,
  keyRangeWhere = "",
}) {
  const childBracket = bracketMssqlIdent(childColumn);
  const tiebreakerOrderBy = mssqlExamIdWithIntColumnOrderBy(childColumn);
  const tiebreakerSortKeyExpr = mssqlExamIdWithIntColumnSortKeyExpr(childColumn);
  const sort = buildCreatedDateSortExprs({
    createdDateColumn,
    tiebreakerOrderBy,
    tiebreakerSortKeyExpr,
  });

  const keyRangeClause = keyRangeWhere
    ? `\n  AND (${keyRangeWhere.trim()})`
    : "";

  const keysetLegacy = `
SELECT
  ${legacySelectColumns}
FROM (
  SELECT TOP (@page)
    ${stagingColumns}
  FROM {{sourceObject}}
  WHERE (
    [Exam_ID] > @afterExamId
    OR ([Exam_ID] = @afterExamId AND ${childBracket} > @afterChildId)
  )${keyRangeClause}
  ORDER BY [Exam_ID] ASC, ${childBracket} ASC
) s`.trim();

  const keysetCreatedDate = `
SELECT TOP (@page)
  ${selectColumns},
  ${createdDateSelectExpr(String(createdDateColumn).trim(), "s")}
FROM {{sourceObject}} AS s
WHERE ${examChildCreatedDateWhereClause(String(createdDateColumn).trim(), childColumn)}${keyRangeClause}
ORDER BY ${examChildCreatedDateOrderBy(String(createdDateColumn).trim(), childColumn)}`.trim();

  const detailByExamIds = `
SELECT
  ${selectColumns}
FROM {{sourceObject}}
WHERE [Exam_ID] IN ({{idPlaceholders}})
ORDER BY ${sort.orderBy}`.trim();

  const useCreatedDate = sort.createdDateColumn != null;

  return {
    ...sort,
    keysetSql: useCreatedDate ? keysetCreatedDate : keysetLegacy,
    detailByExamIdsSql: detailByExamIds,
  };
}

/** Exam_ID + Recommend_ID */
export function buildExamRecommendSelectBundle({
  createdDateColumn,
  detailColumns,
  keyRangeWhere = "",
}) {
  const recommendSortKey = `CONCAT(${MSSQL_EXAM_ID_SORT_KEY_EXPR}, N'_', ${mssqlIntColumnSortKeyExpr("[Recommend_ID]")})`;
  const sort = buildCreatedDateSortExprs({
    createdDateColumn,
    tiebreakerOrderBy: "[Exam_ID] ASC, [Recommend_ID] ASC",
    tiebreakerSortKeyExpr: recommendSortKey,
  });

  const keyRangeClause = keyRangeWhere
    ? `\n  AND (${keyRangeWhere.trim()})`
    : "";

  const idProbeLegacy = `
SELECT CAST(s.[Exam_ID] AS BIGINT) AS exam_id
FROM (
  SELECT TOP (@page)
    [Exam_ID]
  FROM {{sourceObject}}
  WHERE [Exam_ID] > @afterExamId${keyRangeClause}
  ORDER BY [Exam_ID] ASC
) s`.trim();

  const idProbeCreatedDate = `
SELECT TOP (@page)
  CAST([Exam_ID] AS BIGINT) AS exam_id,
  ${createdDateSelectExpr(sort.createdDateColumn)}
FROM {{sourceObject}}
WHERE ${examIdOnlyCreatedDateWhereClause(sort.createdDateColumn)}${keyRangeClause}
ORDER BY ${examIdOnlyCreatedDateOrderBy(sort.createdDateColumn)}`.trim();

  const detailByIds = `
SELECT
${detailColumns}
FROM {{sourceObject}}
WHERE CAST([Exam_ID] AS BIGINT) IN ({{idPlaceholders}})
ORDER BY ${sort.orderBy}`.trim();

  const useCreatedDate = sort.createdDateColumn != null;

  return {
    ...sort,
    idProbeSql: useCreatedDate ? idProbeCreatedDate : idProbeLegacy,
    detailByIdsSql: detailByIds,
  };
}
