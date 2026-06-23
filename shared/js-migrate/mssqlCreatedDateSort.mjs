export function bracketMssqlIdent(name) {
  return `[${String(name).replace(/]/g, "]]")}]`;
}

function mssqlStringLiteral(value) {
  return `N'${String(value).replace(/'/g, "''")}'`;
}

export const DEFAULT_CREATED_DATE_COLUMN = "CreatedDate";
export const CREATED_DATE_SORT_KEY_VERSION = 2;
export const LEGACY_SORT_KEY_VERSION = 1;

/** BIGINT column → lexicographic sort key (zero-padded 20 digits) */
export function mssqlBigIntColumnSortKeyExpr(bracketedColumn) {
  return `CONCAT(
    N'0',
    RIGHT(
      REPLICATE(N'0', 20) + CAST(CAST(${bracketedColumn} AS BIGINT) AS NVARCHAR(30)),
      20
    )
  )`;
}

/** INT column → lexicographic sort key (zero-padded 10 digits) */
export function mssqlIntColumnSortKeyExpr(bracketedColumn) {
  return `CONCAT(
    N'0',
    RIGHT(
      REPLICATE(N'0', 10) + CAST(CONVERT(INT, ${bracketedColumn}) AS NVARCHAR(12)),
      10
    )
  )`;
}

export const MSSQL_EXAM_ID_ORDER_BY = "[Exam_ID] ASC";
export const MSSQL_EXAM_ID_SORT_KEY_EXPR =
  mssqlBigIntColumnSortKeyExpr("[Exam_ID]");

export function mssqlExamIdWithIntColumnOrderBy(intColumn) {
  const col = bracketMssqlIdent(intColumn);
  return `[Exam_ID] ASC, ${col} ASC`;
}

export function mssqlExamIdWithIntColumnSortKeyExpr(intColumn) {
  const col = bracketMssqlIdent(intColumn);
  return `CONCAT(${MSSQL_EXAM_ID_SORT_KEY_EXPR}, N'_', ${mssqlIntColumnSortKeyExpr(col)})`;
}

/**
 * CreatedDate NULL ก่อน (ข้อมูลเก่า) → ตามวันที่สร้างเก่า→ใหม่ → tiebreaker
 * @param {{ createdDateColumn?: string | null, tiebreakerOrderBy: string, tiebreakerSortKeyExpr: string, fastOrderBy?: string | null }} opts
 */
export function buildCreatedDateSortExprs({
  createdDateColumn,
  tiebreakerOrderBy,
  tiebreakerSortKeyExpr,
  fastOrderBy = null,
}) {
  if (createdDateColumn == null || String(createdDateColumn).trim() === "") {
    return {
      sortKeyVersion: LEGACY_SORT_KEY_VERSION,
      createdDateColumn: null,
      sortKeyExpr: tiebreakerSortKeyExpr,
      orderBy: tiebreakerOrderBy,
      fastOrderBy: fastOrderBy ?? tiebreakerOrderBy,
    };
  }

  const cd = bracketMssqlIdent(String(createdDateColumn).trim());
  const sortKeyExpr = `CASE WHEN ${cd} IS NULL
  THEN CONCAT(N'0', ${tiebreakerSortKeyExpr})
  ELSE CONCAT(
    N'1',
    CONVERT(VARCHAR(23), ${cd}, 126),
    N'_',
    ${tiebreakerSortKeyExpr}
  )
END`;
  const orderBy = `CASE WHEN ${cd} IS NULL THEN 0 ELSE 1 END ASC, ${cd} ASC, ${tiebreakerOrderBy}`;
  const resolvedFastOrderBy = fastOrderBy ?? `${cd} ASC, ${tiebreakerOrderBy}`;

  return {
    sortKeyVersion: CREATED_DATE_SORT_KEY_VERSION,
    createdDateColumn: String(createdDateColumn).trim(),
    sortKeyExpr,
    orderBy,
    fastOrderBy: resolvedFastOrderBy,
  };
}

/**
 * ตรวจว่ามีคอลัมน์ CreatedDate บน MSSQL หรือไม่
 * override ด้วย migration.createdDateColumn หรือ migration.<tableSpecificKey>
 * คืน null เมื่อไม่มีคอลัมน์ → ใช้ลำดับเดิม
 */
export async function resolveMssqlCreatedDateColumn(
  mssqlPool,
  {
    migrationConfig = {},
    sourceSchema = "dbo",
    sourceTable,
    tableLabel,
    configKey = "createdDateColumn",
  },
) {
  const cfg =
    migrationConfig?.[configKey] ?? migrationConfig?.createdDateColumn;
  if (cfg === false || cfg === null) return null;
  if (typeof cfg === "string" && cfg.trim() === "") return null;

  const explicitColumn =
    typeof cfg === "string" && cfg.trim() !== "" ? cfg.trim() : null;
  const column = explicitColumn ?? DEFAULT_CREATED_DATE_COLUMN;

  const res = await mssqlPool.request().query(`
    SELECT 1 AS ok
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = ${mssqlStringLiteral(sourceSchema)}
      AND TABLE_NAME = ${mssqlStringLiteral(sourceTable)}
      AND COLUMN_NAME = ${mssqlStringLiteral(column)}
  `);
  if ((res.recordset?.length ?? 0) === 0) {
    if (explicitColumn == null) return null;
    throw new Error(
      `[${tableLabel}] MSSQL ${sourceSchema}.${sourceTable} ไม่มีคอลัมน์ '${column}' — ` +
        `ตรวจ migration.${configKey} หรือตั้งเป็น "" เพื่อเรียงแบบเดิม`,
    );
  }
  return column;
}

/** รีเซ็ต checkpoint keyset เมื่ออัปเกรดจากเรียงแบบเดิม → CreatedDate v2 */
export function reconcileCreatedDateSortCheckpoint({
  checkpoint = {},
  sortKeyVersion,
  useCreatedDateSort,
  legacyNumericAfter = 0,
  legacyNumericFieldPresent = false,
}) {
  const checkpointSortKeyVersion = Number(
    checkpoint.sortKeyVersion ?? LEGACY_SORT_KEY_VERSION,
  );
  let sortKeyVersionUpgraded = false;
  let mssqlKeysetAfter =
    checkpoint.mssqlKeysetAfter == null
      ? ""
      : String(checkpoint.mssqlKeysetAfter);
  let numericAfter = legacyNumericAfter;

  const hadLegacyProgress =
    legacyNumericFieldPresent &&
    (Number(checkpoint.afterExamId ?? 0) > legacyNumericAfter ||
      Number(checkpoint.afterScheduleId ?? -1) > legacyNumericAfter ||
      Number(checkpoint.offset ?? 0) > 0 ||
      (checkpoint.mssqlKeysetAfter != null &&
        String(checkpoint.mssqlKeysetAfter).trim() !== "" &&
        !useCreatedDateSort));

  if (
    useCreatedDateSort &&
    sortKeyVersion === CREATED_DATE_SORT_KEY_VERSION &&
    checkpointSortKeyVersion < CREATED_DATE_SORT_KEY_VERSION &&
    hadLegacyProgress
  ) {
    sortKeyVersionUpgraded = true;
    mssqlKeysetAfter = "";
    numericAfter = legacyNumericAfter;
  }

  if (!useCreatedDateSort) {
    mssqlKeysetAfter = null;
  }

  return {
    sortKeyVersionUpgraded,
    mssqlKeysetAfter: useCreatedDateSort ? mssqlKeysetAfter : null,
    numericAfter,
    checkpointSortKeyVersion,
  };
}

export function createdDateSortLogLine(tableLabel, sortBundle) {
  return sortBundle?.createdDateColumn
    ? `>>> [${tableLabel}] sort: ${sortBundle.createdDateColumn} NULL ก่อน → วันที่เก่า→ใหม่ + tiebreaker`
    : `>>> [${tableLabel}] sort: ไม่มี CreatedDate — เรียง tiebreaker อย่างเดียว`;
}
