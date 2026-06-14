import sql from "mssql";

/**
 * คิวรีอ่าน dbo.patient_info จาก MSSQL แบ่งหน้า
 *
 * มี CreatedDate: NULL ก่อน (ข้อมูลเก่า) แล้วตามวันที่สร้างจากเก่า→ใหม่ + PID tiebreaker
 * ไม่มี CreatedDate: เรียง PID (ตัวเลขก่อน) แบบเดิม
 */

export const MSSQL_PID_TRIM_EXPR = `LTRIM(RTRIM(CAST([PID] AS NVARCHAR(4000))))`;

/** NULL เมื่อ PID ไม่ใช่จำนวนเต็ม */
export const MSSQL_PID_NUMERIC_BIGINT_EXPR = `TRY_CAST(${MSSQL_PID_TRIM_EXPR} AS BIGINT)`;

/**
 * tiebreaker ตาม PID: N'0' + zero-pad 20 หลักสำหรับตัวเลข, N'1' + ข้อความสำหรับ non-numeric
 */
export const MSSQL_PID_SORT_KEY_EXPR = `CASE WHEN ${MSSQL_PID_NUMERIC_BIGINT_EXPR} IS NOT NULL
  THEN CONCAT(
    N'0',
    RIGHT(
      REPLICATE(N'0', 20) + CAST(${MSSQL_PID_NUMERIC_BIGINT_EXPR} AS NVARCHAR(30)),
      20
    )
  )
  ELSE CONCAT(N'1', ${MSSQL_PID_TRIM_EXPR})
END`;

export const MSSQL_PID_ORDER_BY = `${MSSQL_PID_SORT_KEY_EXPR} ASC`;

export const MSSQL_PATIENT_INFO_SRC_WHERE = `
(@migrateSrcKeyMin IS NULL OR ${MSSQL_PID_NUMERIC_BIGINT_EXPR} >= @migrateSrcKeyMin)
  AND (@migrateSrcKeyMax IS NULL OR ${MSSQL_PID_NUMERIC_BIGINT_EXPR} <= @migrateSrcKeyMax)`;

const MSSQL_PATIENT_INFO_DETAIL_COLUMNS = `
  CAST([PID] AS NVARCHAR(MAX)) AS pid,
  CAST([Prefix] AS NVARCHAR(MAX)) AS prefix,
  CAST([Name] AS NVARCHAR(MAX)) AS [name],
  CAST([Surname] AS NVARCHAR(MAX)) AS surname,
  CONVERT(VARCHAR(30), [DateOfBirth], 126) AS date_of_birth_be,
  CAST([Single] AS NVARCHAR(MAX)) AS single,
  CAST([Address] AS NVARCHAR(MAX)) AS address,
  CAST([SubArea] AS NVARCHAR(MAX)) AS sub_area,
  CAST([Area] AS NVARCHAR(MAX)) AS area,
  CAST([Province] AS NVARCHAR(MAX)) AS province,
  CAST([Zip] AS NVARCHAR(MAX)) AS zip,
  CAST([Phone_BIZ] AS NVARCHAR(MAX)) AS phone_biz,
  CAST([Phone_Home] AS NVARCHAR(MAX)) AS phone_home,
  CAST(CAST([Height] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS height,
  CAST(CAST([Weight] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS weight,
  CAST([Current_Breast_Compo] AS NVARCHAR(MAX)) AS current_breast_compo,
  CAST([Current_implant_Type] AS NVARCHAR(MAX)) AS current_implant_type,
  CONVERT(VARCHAR(30), [LastExamDate], 126) AS last_exam_date,
  CAST([Mobile] AS NVARCHAR(MAX)) AS mobile,
  CONVERT(VARCHAR(30), [MobileUpdated], 126) AS mobile_updated,
  CAST(CAST([Donate_Type] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS donate_type,
  CAST([EngPrefix] AS NVARCHAR(MAX)) AS eng_prefix,
  CAST([EngName] AS NVARCHAR(MAX)) AS eng_name,
  CAST([EngSurname] AS NVARCHAR(MAX)) AS eng_surname,
  CAST([SocID] AS NVARCHAR(MAX)) AS soc_id,
  CAST([HN] AS NVARCHAR(MAX)) AS hn,
  CAST([Gender] AS NVARCHAR(MAX)) AS gender,
  CAST([Address2] AS NVARCHAR(MAX)) AS address2,
  CAST([ShortNote] AS NVARCHAR(MAX)) AS short_note,
  CAST([Disease] AS NVARCHAR(MAX)) AS disease,
  CAST([Mobile_Phone] AS NVARCHAR(MAX)) AS mobile_phone,
  CAST([Email] AS NVARCHAR(MAX)) AS email`.trim();

function bracketMssqlIdent(name) {
  return `[${String(name).replace(/]/g, "]]")}]`;
}

function buildSortExprs(createdDateColumn) {
  if (createdDateColumn == null || String(createdDateColumn).trim() === "") {
    return {
      sortKeyVersion: 1,
      createdDateColumn: null,
      sortKeyExpr: MSSQL_PID_SORT_KEY_EXPR,
      orderBy: MSSQL_PID_ORDER_BY,
      fastOrderBy: "[PID] ASC",
    };
  }

  const cd = bracketMssqlIdent(String(createdDateColumn).trim());
  const sortKeyExpr = `CASE WHEN ${cd} IS NULL
  THEN CONCAT(N'0', ${MSSQL_PID_SORT_KEY_EXPR})
  ELSE CONCAT(
    N'1',
    CONVERT(VARCHAR(23), ${cd}, 126),
    N'_',
    ${MSSQL_PID_SORT_KEY_EXPR}
  )
END`;
  const orderBy = `CASE WHEN ${cd} IS NULL THEN 0 ELSE 1 END ASC, ${cd} ASC, ${MSSQL_PID_SORT_KEY_EXPR} ASC`;
  const fastOrderBy = `${cd} ASC, [PID] ASC`;

  return {
    sortKeyVersion: 2,
    createdDateColumn: String(createdDateColumn).trim(),
    sortKeyExpr,
    orderBy,
    fastOrderBy,
  };
}

/**
 * @param {string | null | undefined} createdDateColumn ชื่อคอลัมน์ MSSQL หรือ null = เรียง PID
 */
export function createMssqlPatientInfoSelectBundle(createdDateColumn) {
  const sort = buildSortExprs(createdDateColumn);

  const offsetSelect = `
SELECT
  ${MSSQL_PATIENT_INFO_DETAIL_COLUMNS}
FROM {{sourceObject}}
WHERE ${MSSQL_PATIENT_INFO_SRC_WHERE}
ORDER BY {{orderBy}}
OFFSET @offset ROWS FETCH NEXT @page ROWS ONLY;
`.trim();

  const keysetSelect = `
SELECT TOP (@page)
  ${MSSQL_PATIENT_INFO_DETAIL_COLUMNS},
  ${sort.sortKeyExpr} AS __mssql_sort_key
FROM {{sourceObject}}
WHERE ${sort.sortKeyExpr} > @afterSortKey
  AND ${MSSQL_PATIENT_INFO_SRC_WHERE}
ORDER BY ${sort.orderBy};
`.trim();

  const idProbeSelect = `
SELECT TOP (@page)
  CAST([PID] AS NVARCHAR(MAX)) AS pid,
  ${sort.sortKeyExpr} AS __mssql_sort_key
FROM {{sourceObject}}
WHERE ${sort.sortKeyExpr} > @afterSortKey
  AND ${MSSQL_PATIENT_INFO_SRC_WHERE}
ORDER BY ${sort.orderBy};
`.trim();

  const fingerprintSql = `
SELECT
  COUNT_BIG(1) AS total_n,
  MAX(${sort.sortKeyExpr}) AS max_sort_key
FROM {{sourceObject}}
WHERE ${MSSQL_PATIENT_INFO_SRC_WHERE};
`.trim();

  const byPidsSelect = `
SELECT
  ${MSSQL_PATIENT_INFO_DETAIL_COLUMNS}
FROM {{sourceObject}}
WHERE [PID] IN ({{idPlaceholders}})
ORDER BY ${sort.orderBy}
`.trim();

  return {
    ...sort,
    offsetSelect,
    keysetSelect,
    idProbeSelect,
    fingerprintSql,
    byPidsSelect,
  };
}

/** bundle ค่าเริ่มต้น (CreatedDate) — ใช้ createMssqlPatientInfoSelectBundle หลัง resolve คอลัมน์จริง */
export const defaultMssqlPatientInfoSelectBundle =
  createMssqlPatientInfoSelectBundle("CreatedDate");

export const MSSQL_PATIENT_INFO_SELECT = defaultMssqlPatientInfoSelectBundle.offsetSelect;
export const MSSQL_PATIENT_INFO_ORDER_BY = defaultMssqlPatientInfoSelectBundle.orderBy;
export const MSSQL_PATIENT_INFO_FAST_ORDER_BY =
  defaultMssqlPatientInfoSelectBundle.fastOrderBy;
export const MSSQL_PATIENT_INFO_SORT_KEY_EXPR =
  defaultMssqlPatientInfoSelectBundle.sortKeyExpr;
export const MSSQL_PID_FAST_ORDER_BY = MSSQL_PATIENT_INFO_FAST_ORDER_BY;

export function buildMssqlPatientInfoKeysetSelect(createdDateColumn) {
  return createMssqlPatientInfoSelectBundle(createdDateColumn).keysetSelect;
}

export function buildMssqlPatientInfoIdProbeKeysetSelect(createdDateColumn) {
  return createMssqlPatientInfoSelectBundle(createdDateColumn).idProbeSelect;
}

export function buildMssqlPatientInfoSourceFingerprintSql(createdDateColumn) {
  return createMssqlPatientInfoSelectBundle(createdDateColumn).fingerprintSql;
}

export const MSSQL_PATIENT_INFO_BY_PIDS_SELECT =
  defaultMssqlPatientInfoSelectBundle.byPidsSelect;

const DEFAULT_CREATED_DATE_COLUMN = "CreatedDate";

/**
 * ชื่อคอลัมน์ CreatedDate บน MSSQL (ค่าเริ่มต้น CreatedDate)
 * override ได้ด้วย migration.patientInfoCreatedDateColumn
 * คืน null เมื่อไม่มีคอลัมน์ (หรือตั้งเป็น "" / false) → เรียง PID อย่างเดียว
 * @throws {Error} ถ้าตั้ง patientInfoCreatedDateColumn เป็นชื่ออื่นแต่คอลัมน์ไม่มี
 */
export async function resolvePatientInfoCreatedDateColumn(
  mssqlPool,
  migrationConfig,
  sourceSchema = "dbo",
  sourceTable = "patient_info",
) {
  const cfg = migrationConfig?.patientInfoCreatedDateColumn;
  if (cfg === false || cfg === null) return null;
  if (typeof cfg === "string" && cfg.trim() === "") return null;

  const explicitColumn =
    typeof cfg === "string" && cfg.trim() !== "" ? cfg.trim() : null;
  const column = explicitColumn ?? DEFAULT_CREATED_DATE_COLUMN;

  const req = mssqlPool.request();
  req.input("schema", sql.NVarChar(128), sourceSchema);
  req.input("table", sql.NVarChar(128), sourceTable);
  req.input("column", sql.NVarChar(128), column);
  const res = await req.query(`
    SELECT 1 AS ok
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @schema
      AND TABLE_NAME = @table
      AND COLUMN_NAME = @column
  `);
  if ((res.recordset?.length ?? 0) === 0) {
    if (explicitColumn == null) return null;
    throw new Error(
      `[patient_info] MSSQL ${sourceSchema}.${sourceTable} ไม่มีคอลัมน์ '${column}' ` +
        `(server/database ที่ config ชี้อยู่ยังไม่ได้ sync schema) — ` +
        `ตรวจ migration.patientInfoCreatedDateColumn หรือตั้งเป็น "" เพื่อเรียง PID อย่างเดียว`,
    );
  }
  return column;
}

