/**
 * dbo.pacs_sync_info — รองรับสองโหมด fetch ที่ MSSQL:
 * A) probe + detail IN (เหมือน examination_general; แนะนำ IN ครั้งเดียวต่อ batch = detailInChunkSize=batchSize)
 * B) คิวรี่เดียวต่อ chunk — TOP + INNER JOIN (เร็วเมื่อเครือข่ายหน่วง; ไม่ส่ง @id หลายพันตัว)
 */
import { buildCreatedDateSortExprs } from "../../shared/js-migrate/mssqlCreatedDateSort.mjs";

const PACS_OFFSET_TIEBREAKER_ORDER_BY = `CASE WHEN [Accession_ID] IS NULL THEN 0 ELSE 1 END ASC,
  [Accession_ID] ASC,
  TRY_CAST([Exam_ID] AS BIGINT) ASC,
  [Dl_DT] ASC,
  NULLIF(LTRIM(RTRIM([PID])), '') ASC,
  [StudyNo] ASC,
  NULLIF(LTRIM(RTRIM([RISCode])), '') ASC,
  NULLIF(LTRIM(RTRIM([SyncFileName])), '') ASC`;

/** @param {string} [studyDescriptionColumnExpr] ตัวอย่าง `[StudyDescription]` หรือ `p.[StudyDescription]` */
export function studyDescriptionSqlFragment(
  studyDescriptionMaxChars,
  studyDescriptionColumnExpr = "[StudyDescription]",
) {
  const trim = `NULLIF(LTRIM(RTRIM(${studyDescriptionColumnExpr})), '')`;
  const n = Math.floor(Number(studyDescriptionMaxChars));
  if (!Number.isFinite(n) || n <= 0) {
    return `CONVERT(NVARCHAR(MAX), ${trim}) AS studydescription`;
  }
  const cap = Math.min(Math.max(n, 1), 2_147_483_647);
  return `CAST(LEFT(${trim}, ${cap}) AS NVARCHAR(MAX)) AS studydescription`;
}

/** รายการคอลัมน์จากตารางที่ไม่มี alias (สำหรับ detail IN) */
export function buildPacssyncSelectColumnList(studyDescriptionMaxChars) {
  const studyCol = studyDescriptionSqlFragment(studyDescriptionMaxChars);
  return `
  LTRIM(RTRIM(CONVERT(NVARCHAR(256), [Accession_ID]))) AS accession_id,
  CONVERT(NVARCHAR(100), NULLIF(LTRIM(RTRIM([PID])), '')) AS pid,
  CONVERT(NVARCHAR(50), TRY_CAST([Exam_ID] AS BIGINT)) AS exam_id,
  CONVERT(VARCHAR(33), [Dl_DT], 126) AS dl_dt,
  CONVERT(NVARCHAR(50), NULLIF(LTRIM(RTRIM([Modality])), '')) AS modality,
  CONVERT(NVARCHAR(500), NULLIF(LTRIM(RTRIM([SeriesPerformed])), '')) AS seriesperformed,
  CONVERT(NVARCHAR(50), CAST([Status] AS NVARCHAR(50))) AS status,
  CONVERT(NVARCHAR(10), CAST([IsNormalStudy] AS NVARCHAR(10))) AS isnormalstudy,
  CONVERT(NVARCHAR(50), [StudyNo]) AS studyno,
  ${studyCol},
  CONVERT(NVARCHAR(10), CAST([IsMarkDel] AS NVARCHAR(10))) AS ismarkdel,
  CONVERT(VARCHAR(33), [PACsSyncTime], 126) AS pacssynctime,
  CONVERT(NVARCHAR(100), [WorklistCode]) AS worklistcode,
  CONVERT(NVARCHAR(200), NULLIF(LTRIM(RTRIM([RISCode])), '')) AS riscode,
  CONVERT(NVARCHAR(500), NULLIF(LTRIM(RTRIM([SyncFileName])), '')) AS syncfilename`.trim();
}

/** รายการคอลัมน์จาก alias p (สำหรับ TOP+JOIN) + __checkpoint_acc_key สำหรับ keyset */
export function buildPacssyncJoinedOuterSelectList(studyDescriptionMaxChars) {
  const p = "p";
  const studyCol = studyDescriptionSqlFragment(
    studyDescriptionMaxChars,
    `${p}.[StudyDescription]`,
  );
  return `
  ${p}.[Accession_ID] AS __checkpoint_acc_key,
  LTRIM(RTRIM(CONVERT(NVARCHAR(256), ${p}.[Accession_ID]))) AS accession_id,
  CONVERT(NVARCHAR(100), NULLIF(LTRIM(RTRIM(${p}.[PID])), '')) AS pid,
  CONVERT(NVARCHAR(50), TRY_CAST(${p}.[Exam_ID] AS BIGINT)) AS exam_id,
  CONVERT(VARCHAR(33), ${p}.[Dl_DT], 126) AS dl_dt,
  CONVERT(NVARCHAR(50), NULLIF(LTRIM(RTRIM(${p}.[Modality])), '')) AS modality,
  CONVERT(NVARCHAR(500), NULLIF(LTRIM(RTRIM(${p}.[SeriesPerformed])), '')) AS seriesperformed,
  CONVERT(NVARCHAR(50), CAST(${p}.[Status] AS NVARCHAR(50))) AS status,
  CONVERT(NVARCHAR(10), CAST(${p}.[IsNormalStudy] AS NVARCHAR(10))) AS isnormalstudy,
  CONVERT(NVARCHAR(50), ${p}.[StudyNo]) AS studyno,
  ${studyCol},
  CONVERT(NVARCHAR(10), CAST(${p}.[IsMarkDel] AS NVARCHAR(10))) AS ismarkdel,
  CONVERT(VARCHAR(33), ${p}.[PACsSyncTime], 126) AS pacssynctime,
  CONVERT(NVARCHAR(100), ${p}.[WorklistCode]) AS worklistcode,
  CONVERT(NVARCHAR(200), NULLIF(LTRIM(RTRIM(${p}.[RISCode])), '')) AS riscode,
  CONVERT(NVARCHAR(500), NULLIF(LTRIM(RTRIM(${p}.[SyncFileName])), '')) AS syncfilename`.trim();
}

/** สำหรับโหมด IN — มี {{sourceObject}}, {{idPlaceholders}} */
export function buildMssqlPacsSyncInfoDetailSql(studyDescriptionMaxChars) {
  const cols = buildPacssyncSelectColumnList(studyDescriptionMaxChars);
  return `
SELECT
${cols}
FROM {{sourceObject}}
WHERE [Accession_ID] IN ({{idPlaceholders}})
ORDER BY [Accession_ID] ASC
`.trim();
}

/** โหมดเร็ว: chunk แรก ({{sourceTable}} = [sch].[tbl] อย่างเดียว) */
export function buildMssqlPacsSyncInfoChunkSqlFirst(studyDescriptionMaxChars) {
  const cols = buildPacssyncJoinedOuterSelectList(studyDescriptionMaxChars);
  return `
SELECT
${cols}
FROM (
  SELECT TOP (@page)
    [Accession_ID]
  FROM {{sourceTable}} WITH (NOLOCK)
  WHERE [Accession_ID] IS NOT NULL
    AND (@migrateSrcKeyMin IS NULL OR TRY_CAST([Accession_ID] AS BIGINT) >= @migrateSrcKeyMin)
    AND (@migrateSrcKeyMax IS NULL OR TRY_CAST([Accession_ID] AS BIGINT) <= @migrateSrcKeyMax)
  ORDER BY [Accession_ID] ASC
) AS k
INNER JOIN {{sourceTable}} AS p WITH (NOLOCK) ON p.[Accession_ID] = k.[Accession_ID]
ORDER BY p.[Accession_ID] ASC
`.trim();
}

/** โหมดเร็ว: keyset */
export function buildMssqlPacsSyncInfoChunkSqlKeyset(studyDescriptionMaxChars) {
  const cols = buildPacssyncJoinedOuterSelectList(studyDescriptionMaxChars);
  return `
SELECT
${cols}
FROM (
  SELECT TOP (@page)
    [Accession_ID]
  FROM {{sourceTable}} WITH (NOLOCK)
  WHERE [Accession_ID] > @afterAccessionKey
    AND (@migrateSrcKeyMin IS NULL OR TRY_CAST([Accession_ID] AS BIGINT) >= @migrateSrcKeyMin)
    AND (@migrateSrcKeyMax IS NULL OR TRY_CAST([Accession_ID] AS BIGINT) <= @migrateSrcKeyMax)
  ORDER BY [Accession_ID] ASC
) AS k
INNER JOIN {{sourceTable}} AS p WITH (NOLOCK) ON p.[Accession_ID] = k.[Accession_ID]
ORDER BY p.[Accession_ID] ASC
`.trim();
}

/**
 * TOP+JOIN + keyset แบบ composite — ดึงทุกแถวที่มี Accession_ID (รวมซ้ำค่า Accession)
 * ลำดับ: Accession_ID, Exam_ID, Dl_DT, PID, fingerprint (เร็วระดับเดียวกับ keyset เดิมต่อ chunk)
 */
export function buildMssqlPacsSyncInfoChunkSqlFirstComposite(
  studyDescriptionMaxChars,
) {
  const cols = buildPacssyncJoinedOuterSelectList(studyDescriptionMaxChars);
  const fpV = rowFingerprintHashExpr("v");
  const chkV = rowBinaryChecksumExpr("v");
  const chkP = rowBinaryChecksumExpr("p");
  return `
SELECT
${cols},
  k.__k_e AS __acc_ck_exam,
  CONVERT(VARCHAR(33), k.__k_d, 126) AS __acc_ck_dl,
  k.__k_p AS __acc_ck_pid,
  k.__k_fp AS __acc_ck_fp,
  k.__k_chk AS __acc_ck_chk
FROM (
  SELECT TOP (@page)
    v.[Accession_ID],
    COALESCE(TRY_CAST(v.[Exam_ID] AS BIGINT), CAST(-9223372036854775808 AS BIGINT)) AS __k_e,
    COALESCE(v.[Dl_DT], CAST('17530101' AS DATETIME2)) AS __k_d,
    ISNULL(NULLIF(LTRIM(RTRIM(v.[PID])), N''), N'') AS __k_p,
    ${fpV} AS __k_fp,
    ${chkV} AS __k_chk
  FROM {{sourceTable}} AS v WITH (NOLOCK)
  WHERE v.[Accession_ID] IS NOT NULL
  ORDER BY
    v.[Accession_ID] ASC,
    COALESCE(TRY_CAST(v.[Exam_ID] AS BIGINT), CAST(-9223372036854775808 AS BIGINT)),
    COALESCE(v.[Dl_DT], CAST('17530101' AS DATETIME2)),
    ISNULL(NULLIF(LTRIM(RTRIM(v.[PID])), N''), N''),
    ${fpV},
    ${chkV}
) AS k
INNER JOIN {{sourceTable}} AS p WITH (NOLOCK)
  ON p.[Accession_ID] = k.[Accession_ID]
 AND COALESCE(TRY_CAST(p.[Exam_ID] AS BIGINT), CAST(-9223372036854775808 AS BIGINT)) = k.__k_e
 AND COALESCE(p.[Dl_DT], CAST('17530101' AS DATETIME2)) = k.__k_d
 AND ISNULL(NULLIF(LTRIM(RTRIM(p.[PID])), N''), N'') = k.__k_p
 AND ${rowFingerprintHashExpr("p")} = k.__k_fp
 AND ${chkP} = k.__k_chk
ORDER BY
  p.[Accession_ID] ASC,
  k.__k_e,
  k.__k_d,
  k.__k_p,
  k.__k_fp,
  k.__k_chk
`.trim();
}

export function buildMssqlPacsSyncInfoChunkSqlKeysetComposite(
  studyDescriptionMaxChars,
) {
  const cols = buildPacssyncJoinedOuterSelectList(studyDescriptionMaxChars);
  const fpV = rowFingerprintHashExpr("v");
  const chkV = rowBinaryChecksumExpr("v");
  const chkP = rowBinaryChecksumExpr("p");
  return `
SELECT
${cols},
  k.__k_e AS __acc_ck_exam,
  CONVERT(VARCHAR(33), k.__k_d, 126) AS __acc_ck_dl,
  k.__k_p AS __acc_ck_pid,
  k.__k_fp AS __acc_ck_fp,
  k.__k_chk AS __acc_ck_chk
FROM (
  SELECT TOP (@page)
    v.[Accession_ID],
    COALESCE(TRY_CAST(v.[Exam_ID] AS BIGINT), CAST(-9223372036854775808 AS BIGINT)) AS __k_e,
    COALESCE(v.[Dl_DT], CAST('17530101' AS DATETIME2)) AS __k_d,
    ISNULL(NULLIF(LTRIM(RTRIM(v.[PID])), N''), N'') AS __k_p,
    ${fpV} AS __k_fp,
    ${chkV} AS __k_chk
  FROM {{sourceTable}} AS v WITH (NOLOCK)
  WHERE v.[Accession_ID] IS NOT NULL
    AND (
      v.[Accession_ID] > @afterAccessionKey
      OR (
        v.[Accession_ID] = @afterAccessionKey
        AND (
          COALESCE(TRY_CAST(v.[Exam_ID] AS BIGINT), CAST(-9223372036854775808 AS BIGINT)) > @accCkAfterExam
          OR (
            COALESCE(TRY_CAST(v.[Exam_ID] AS BIGINT), CAST(-9223372036854775808 AS BIGINT)) = @accCkAfterExam
            AND COALESCE(v.[Dl_DT], CAST('17530101' AS DATETIME2)) > @accCkAfterDl
          )
          OR (
            COALESCE(TRY_CAST(v.[Exam_ID] AS BIGINT), CAST(-9223372036854775808 AS BIGINT)) = @accCkAfterExam
            AND COALESCE(v.[Dl_DT], CAST('17530101' AS DATETIME2)) = @accCkAfterDl
            AND ISNULL(NULLIF(LTRIM(RTRIM(v.[PID])), N''), N'') > @accCkAfterPid
          )
          OR (
            COALESCE(TRY_CAST(v.[Exam_ID] AS BIGINT), CAST(-9223372036854775808 AS BIGINT)) = @accCkAfterExam
            AND COALESCE(v.[Dl_DT], CAST('17530101' AS DATETIME2)) = @accCkAfterDl
            AND ISNULL(NULLIF(LTRIM(RTRIM(v.[PID])), N''), N'') = @accCkAfterPid
            AND (
              ${fpV} > @accCkAfterFp
              OR (
                ${fpV} = @accCkAfterFp
                AND ${chkV} > @accCkAfterChk
              )
            )
          )
        )
      )
    )
  ORDER BY
    v.[Accession_ID] ASC,
    COALESCE(TRY_CAST(v.[Exam_ID] AS BIGINT), CAST(-9223372036854775808 AS BIGINT)),
    COALESCE(v.[Dl_DT], CAST('17530101' AS DATETIME2)),
    ISNULL(NULLIF(LTRIM(RTRIM(v.[PID])), N''), N''),
    ${fpV},
    ${chkV}
) AS k
INNER JOIN {{sourceTable}} AS p WITH (NOLOCK)
  ON p.[Accession_ID] = k.[Accession_ID]
 AND COALESCE(TRY_CAST(p.[Exam_ID] AS BIGINT), CAST(-9223372036854775808 AS BIGINT)) = k.__k_e
 AND COALESCE(p.[Dl_DT], CAST('17530101' AS DATETIME2)) = k.__k_d
 AND ISNULL(NULLIF(LTRIM(RTRIM(p.[PID])), N''), N'') = k.__k_p
 AND ${rowFingerprintHashExpr("p")} = k.__k_fp
 AND ${chkP} = k.__k_chk
ORDER BY
  p.[Accession_ID] ASC,
  k.__k_e,
  k.__k_d,
  k.__k_p,
  k.__k_fp,
  k.__k_chk
`.trim();
}

/** Chunk แรก / หลัง checkpoint reset — โหมด probe+IN */
export const MSSQL_PACSSYNC_INFO_ID_SELECT_FIRST = `
SELECT TOP (@page)
  [Accession_ID] AS __acc_key
FROM {{sourceObject}}
WHERE [Accession_ID] IS NOT NULL
  AND (@migrateSrcKeyMin IS NULL OR TRY_CAST([Accession_ID] AS BIGINT) >= @migrateSrcKeyMin)
  AND (@migrateSrcKeyMax IS NULL OR TRY_CAST([Accession_ID] AS BIGINT) <= @migrateSrcKeyMax)
ORDER BY [Accession_ID] ASC
`.trim();

/** keyset ต่อจากค่าสุดท้ายของ chunk ก่อนหน้า */
export const MSSQL_PACSSYNC_INFO_ID_SELECT_KEYSET = `
SELECT TOP (@page)
  [Accession_ID] AS __acc_key
FROM {{sourceObject}}
WHERE [Accession_ID] > @afterAccessionKey
  AND (@migrateSrcKeyMin IS NULL OR TRY_CAST([Accession_ID] AS BIGINT) >= @migrateSrcKeyMin)
  AND (@migrateSrcKeyMax IS NULL OR TRY_CAST([Accession_ID] AS BIGINT) <= @migrateSrcKeyMax)
ORDER BY [Accession_ID] ASC
`.trim();

/**
 * ดึงทุกแถวตามลำดับคงที่ (รวม [Accession_ID] เป็น NULL) — ใช้ OFFSET/FETCH กับ checkpoint.offset
 * ช้ากว่า keyset เมื่อ offset สูง แต่ไม่ตัดแถวออกจากเงื่อนไข Accession_ID
 */
export function buildMssqlPacsSyncInfoOffsetSql(
  studyDescriptionMaxChars,
  sortBundle = null,
) {
  const cols = buildPacssyncSelectColumnList(studyDescriptionMaxChars);
  const orderBy =
    sortBundle?.createdDateColumn != null
      ? sortBundle.orderBy
      : PACS_OFFSET_TIEBREAKER_ORDER_BY;
  return `
SELECT
${cols}
FROM {{sourceObject}}
ORDER BY
  ${orderBy}
OFFSET @offset ROWS FETCH NEXT @page ROWS ONLY
`.trim();
}

/**
 * fingerprint แถว — ใช้ keyset ต่อเนื่อง (prefix ว่าง = ไม่มี alias ตาราง)
 * ต้องครอบคลุมคอลัมน์ที่อาจต่างแม้ Accession/Exam/Dl/PID ซ้ำ — ไม่เช่นนั้น ORDER BY + fp > last จะข้ามแถวที่ยัง sort เท่ากัน
 */
export function rowFingerprintHashExpr(tableAlias = "") {
  const t = tableAlias === "" ? "" : `${tableAlias}.`;
  return `HASHBYTES(
  'SHA2_256',
  CONCAT(
    N'E:', ISNULL(CAST(TRY_CAST(${t}[Exam_ID] AS BIGINT) AS NVARCHAR(40)), N'~'),
    N'|D:', ISNULL(CONVERT(NVARCHAR(33), ${t}[Dl_DT], 126), N'~'),
    N'|P:', ISNULL(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(510), ${t}[PID]))), N''), N'~'),
    N'|M:', ISNULL(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(50), ${t}[Modality]))), N''), N'~'),
    N'|SN:', ISNULL(CONVERT(NVARCHAR(50), ${t}[StudyNo]), N''),
    N'|SF:', ISNULL(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(500), ${t}[SyncFileName]))), N''), N''),
    N'|St:', ISNULL(CAST(${t}[Status] AS NVARCHAR(50)), N''),
    N'|SP:', ISNULL(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(500), ${t}[SeriesPerformed]))), N''), N''),
    N'|NS:', ISNULL(CAST(${t}[IsNormalStudy] AS NVARCHAR(10)), N''),
    N'|SD:', ISNULL(CAST(LEFT(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(MAX), ${t}[StudyDescription]))), N''), 4000) AS NVARCHAR(4000)), N''),
    N'|IMD:', ISNULL(CAST(${t}[IsMarkDel] AS NVARCHAR(10)), N''),
    N'|PST:', ISNULL(CONVERT(NVARCHAR(33), ${t}[PACsSyncTime], 126), N''),
    N'|WL:', ISNULL(CONVERT(NVARCHAR(100), ${t}[WorklistCode]), N''),
    N'|RIS:', ISNULL(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(200), ${t}[RISCode]))), N''), N'')
  )
)`;
}

/** เวอร์ชันอัลกอริทึม fingerprint — เปลี่ยนเมื่อแก้ hash ด้านบน (checkpoint เก่าต้องรันเฟสใหม่) */
export const PACSSYNC_ROW_FINGERPRINT_VERSION = 3;

/**
 * ตัวแบ่งลำดับรองหลัง HASHBYTES — แก้กรณีหลายแถวมี fingerprint เดียวกัน (keyset ข้ามแถวที่เหลือจนจบก่อนเวลา)
 * ใช้ BINARY_CHECKSUM ครอบคลุมคอลัมน์ข้อมูลหลักทั้งแถว (ไม่ต้องตรงทุกไบต์กับ fingerprint)
 */
export function rowBinaryChecksumExpr(tableAlias = "v") {
  const t = tableAlias === "" ? "" : `${tableAlias}.`;
  return `BINARY_CHECKSUM(
    ${t}[Accession_ID],
    NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(256), ${t}[Accession_ID]))), N''),
    NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(100), ${t}[PID]))), N''),
    TRY_CAST(${t}[Exam_ID] AS BIGINT),
    ${t}[Dl_DT],
    NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(50), ${t}[Modality]))), N''),
    NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(500), ${t}[SeriesPerformed]))), N''),
    CAST(${t}[Status] AS NVARCHAR(50)),
    CAST(${t}[IsNormalStudy] AS NVARCHAR(10)),
    CONVERT(NVARCHAR(50), ${t}[StudyNo]),
    NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(MAX), ${t}[StudyDescription]))), N''),
    CAST(${t}[IsMarkDel] AS NVARCHAR(10)),
    ${t}[PACsSyncTime],
    CONVERT(NVARCHAR(100), ${t}[WorklistCode]),
    NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(200), ${t}[RISCode]))), N''),
    NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(500), ${t}[SyncFileName]))), N'')
  )`;
}

function nullAccessionRowFingerprintExpr() {
  return rowFingerprintHashExpr("");
}

/** chunk แรกของเฟส null-Accession (TOP เดียว ไม่ OFFSET) */
export function buildMssqlPacsSyncInfoNullAccessionChunkSqlFirst(
  studyDescriptionMaxChars,
) {
  const cols = buildPacssyncSelectColumnList(studyDescriptionMaxChars);
  const fp = nullAccessionRowFingerprintExpr();
  return `
SELECT TOP (@page)
${cols},
  TRY_CAST([Exam_ID] AS BIGINT) AS __null_ck_exam,
  CONVERT(VARCHAR(33), [Dl_DT], 126) AS __null_ck_dl,
  CONVERT(NVARCHAR(510), NULLIF(LTRIM(RTRIM([PID])), N'')) AS __null_ck_pid,
  ${fp} AS __null_ck_fp
FROM {{sourceObject}}
WHERE [Accession_ID] IS NULL
ORDER BY
  COALESCE(TRY_CAST([Exam_ID] AS BIGINT), CAST(-9223372036854775808 AS BIGINT)),
  COALESCE([Dl_DT], CAST('17530101' AS DATETIME2)),
  ISNULL(NULLIF(LTRIM(RTRIM([PID])), N''), N''),
  ${fp}
`.trim();
}

/** keyset ต่อจากแถวสุดท้ายของ chunk ก่อนหน้า (เฟส null-Accession) */
export function buildMssqlPacsSyncInfoNullAccessionChunkSqlKeyset(
  studyDescriptionMaxChars,
) {
  const cols = buildPacssyncSelectColumnList(studyDescriptionMaxChars);
  const fp = nullAccessionRowFingerprintExpr();
  return `
SELECT TOP (@page)
${cols},
  TRY_CAST([Exam_ID] AS BIGINT) AS __null_ck_exam,
  CONVERT(VARCHAR(33), [Dl_DT], 126) AS __null_ck_dl,
  CONVERT(NVARCHAR(510), NULLIF(LTRIM(RTRIM([PID])), N'')) AS __null_ck_pid,
  ${fp} AS __null_ck_fp
FROM {{sourceObject}}
WHERE [Accession_ID] IS NULL
  AND (
    COALESCE(TRY_CAST([Exam_ID] AS BIGINT), CAST(-9223372036854775808 AS BIGINT)) > @nullAfterExam
    OR (
      COALESCE(TRY_CAST([Exam_ID] AS BIGINT), CAST(-9223372036854775808 AS BIGINT)) = @nullAfterExam
      AND COALESCE([Dl_DT], CAST('17530101' AS DATETIME2)) > @nullAfterDl
    )
    OR (
      COALESCE(TRY_CAST([Exam_ID] AS BIGINT), CAST(-9223372036854775808 AS BIGINT)) = @nullAfterExam
      AND COALESCE([Dl_DT], CAST('17530101' AS DATETIME2)) = @nullAfterDl
      AND ISNULL(NULLIF(LTRIM(RTRIM([PID])), N''), N'') > @nullAfterPid
    )
    OR (
      COALESCE(TRY_CAST([Exam_ID] AS BIGINT), CAST(-9223372036854775808 AS BIGINT)) = @nullAfterExam
      AND COALESCE([Dl_DT], CAST('17530101' AS DATETIME2)) = @nullAfterDl
      AND ISNULL(NULLIF(LTRIM(RTRIM([PID])), N''), N'') = @nullAfterPid
      AND ${fp} > @nullAfterFp
    )
  )
ORDER BY
  COALESCE(TRY_CAST([Exam_ID] AS BIGINT), CAST(-9223372036854775808 AS BIGINT)),
  COALESCE([Dl_DT], CAST('17530101' AS DATETIME2)),
  ISNULL(NULLIF(LTRIM(RTRIM([PID])), N''), N''),
  ${fp}
`.trim();
}

/** sort key ต่อแถว — ต้องสอดคล้องกับ PACS_OFFSET_TIEBREAKER_ORDER_BY + fingerprint/checksum */
export function buildPacsSyncRowTiebreakerSortKeyExpr() {
  const fp = rowFingerprintHashExpr();
  const chk = rowBinaryChecksumExpr("");
  return `CONCAT(
  CASE WHEN [Accession_ID] IS NULL THEN N'0' ELSE N'1' END,
  N'|',
  ISNULL(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(256), [Accession_ID]))), N''), N''),
  N'|E:',
  RIGHT(
    REPLICATE(N'0', 20) + CAST(
      ISNULL(TRY_CAST([Exam_ID] AS BIGINT), CAST(-9223372036854775808 AS BIGINT)) AS NVARCHAR(30)
    ),
    20
  ),
  N'|D:',
  ISNULL(CONVERT(NVARCHAR(33), [Dl_DT], 126), N'17530101'),
  N'|P:',
  ISNULL(NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(100), [PID]))), N''), N''),
  N'|FP:',
  CONVERT(VARCHAR(64), ${fp}, 2),
  N'|CK:',
  CAST(${chk} AS NVARCHAR(30))
)`;
}

/** @param {string | null | undefined} createdDateColumn */
export function createMssqlPacsSyncInfoSortBundle(createdDateColumn) {
  return buildCreatedDateSortExprs({
    createdDateColumn,
    tiebreakerOrderBy: PACS_OFFSET_TIEBREAKER_ORDER_BY,
    tiebreakerSortKeyExpr: buildPacsSyncRowTiebreakerSortKeyExpr(),
  });
}

/**
 * CreatedDate keyset โหมดเดียว — ทั้งตาราง (รวม Accession NULL) ไม่แยก 2 เฟส
 */
export function buildMssqlPacsSyncInfoCreatedDateKeysetSql(
  studyDescriptionMaxChars,
  sortBundle,
) {
  if (!sortBundle?.createdDateColumn) {
    throw new Error(
      "buildMssqlPacsSyncInfoCreatedDateKeysetSql: ต้องมี CreatedDate ใน sortBundle",
    );
  }
  const cols = buildPacssyncSelectColumnList(studyDescriptionMaxChars);
  return `
SELECT TOP (@page)
${cols},
  ${sortBundle.sortKeyExpr} AS __mssql_sort_key
FROM {{sourceObject}}
WHERE ${sortBundle.sortKeyExpr} > @afterSortKey
ORDER BY ${sortBundle.orderBy}`.trim();
}
