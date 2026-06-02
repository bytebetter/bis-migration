/**
 * คอลัมน์ dbo.billing — CAST แบบเบาเหมือน examination/patient_info
 * (ไม่ LTRIM/RTRIM/CONVERT ซ้ำบน MSSQL; ตัดช่องว่างใน Node ตอนโหลด staging)
 */
export function buildBillingSelectColumns(tablePrefix = "") {
  const t = tablePrefix ? `${tablePrefix}.` : "";
  const n = (col, alias) =>
    `CAST(CAST(${t}[${col}] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS ${alias}`;
  const s = (col, alias) => `CAST(${t}[${col}] AS NVARCHAR(MAX)) AS ${alias}`;
  return `
  CAST(CAST(${t}[Exam_ID] AS BIGINT) AS NVARCHAR(MAX)) AS exam_id,
  CONVERT(VARCHAR(30), ${t}[Exam_Date], 126) AS exam_date,
  CAST(${t}[PID] AS NVARCHAR(MAX)) AS pid,
  CAST(${t}[IsInPatient] AS NVARCHAR(MAX)) AS is_in_patient,
  CAST(${t}[CanClaimExpense] AS NVARCHAR(MAX)) AS can_claim_expense,
  ${s("HNNo", "hnno")},
  ${s("AN", "an")},
  ${s("Room", "room")},
  ${s("Building", "building")},
  ${s("CodeNo", "codeno")},
  ${s("Note", "note")},
  CAST(${t}[Patient_Type] AS NVARCHAR(MAX)) AS patient_type,
  ${n("Total", "total")},
  ${n("Receipt", "receipt")},
  ${s("Receipt_No", "receipt_no")},
  CAST(${t}[A] AS NVARCHAR(MAX)) AS a,
  ${n("A_Price", "a_price")},
  CAST(${t}[B] AS NVARCHAR(MAX)) AS b,
  ${n("B_Price", "b_price")},
  CAST(${t}[C] AS NVARCHAR(MAX)) AS c,
  ${n("C_Price", "c_price")},
  CAST(${t}[D] AS NVARCHAR(MAX)) AS d,
  ${n("D_Price", "d_price")},
  CAST(${t}[E] AS NVARCHAR(MAX)) AS e,
  ${n("E_Price", "e_price")},
  CAST(${t}[F] AS NVARCHAR(MAX)) AS f,
  ${n("F_Price", "f_price")},
  CAST(${t}[G] AS NVARCHAR(MAX)) AS g,
  ${n("G_Price", "g_price")},
  CAST(${t}[H] AS NVARCHAR(MAX)) AS h,
  ${n("H_Price", "h_price")},
  CAST(${t}[I] AS NVARCHAR(MAX)) AS i,
  ${n("I_Price", "i_price")},
  CAST(${t}[J] AS NVARCHAR(MAX)) AS j,
  ${n("J_Price", "j_price")},
  CAST(${t}[K] AS NVARCHAR(MAX)) AS k,
  ${n("K_Price", "k_price")},
  CAST(${t}[L] AS NVARCHAR(MAX)) AS l,
  ${n("L_Price", "l_price")},
  CAST(${t}[M] AS NVARCHAR(MAX)) AS m,
  ${n("M_Price", "m_price")},
  CAST(${t}[N] AS NVARCHAR(MAX)) AS n,
  ${n("N_Price", "n_price")},
  CAST(${t}[O] AS NVARCHAR(MAX)) AS o,
  ${n("O_Price", "o_price")},
  CAST(${t}[P] AS NVARCHAR(MAX)) AS p,
  ${n("P_Price", "p_price")},
  CAST(${t}[Q] AS NVARCHAR(MAX)) AS q,
  ${n("Q_Price", "q_price")},
  CAST(${t}[R] AS NVARCHAR(MAX)) AS r,
  ${n("R_Price", "r_price")},
  CAST(${t}[S] AS NVARCHAR(MAX)) AS s,
  ${n("S_Price", "s_price")},
  CAST(${t}[T] AS NVARCHAR(MAX)) AS t,
  ${n("T_Price", "t_price")},
  CAST(${t}[U] AS NVARCHAR(MAX)) AS u,
  ${n("U_Price", "u_price")},
  ${s("mammogram_tec1", "mammogram_tec1")},
  ${s("mammogram_tec2", "mammogram_tec2")},
  ${s("ultraSound_tec1", "ultrasound_tec1")},
  ${s("ultraSound_tec2", "ultrasound_tec2")},
  ${s("ultraSound_tec3", "ultrasound_tec3")},
  ${s("ultraSound_tec4", "ultrasound_tec4")},
  ${s("ultraSound_tec5", "ultrasound_tec5")},
  ${s("ultraSound_tec6", "ultrasound_tec6")},
  CAST(${t}[StereoBiopPosition] AS NVARCHAR(MAX)) AS stereo_biop_position,
  CAST(${t}[USGuidedBxPosition] AS NVARCHAR(MAX)) AS us_guided_bx_position,
  CAST(${t}[AspirationPosition] AS NVARCHAR(MAX)) AS aspiration_position,
  CAST(${t}[DuctogramFilm] AS NVARCHAR(MAX)) AS ductogram_film,
  CAST(${t}[CopyFilmFilm] AS NVARCHAR(MAX)) AS copy_film_film,
  CAST(${t}[Cash] AS NVARCHAR(MAX)) AS cash,
  CONVERT(VARCHAR(30), ${t}[ScheduleDate], 126) AS schedule_date,
  CAST(${t}[OPD] AS NVARCHAR(MAX)) AS opd,
  ${n("OPD_Price", "opd_price")},
  CAST(${t}[Foreigner] AS NVARCHAR(MAX)) AS foreigner
`.trim();
}

const BILLING_KEY_RANGE = `
  AND (@migrateSrcKeyMin IS NULL OR CAST([Exam_ID] AS BIGINT) >= @migrateSrcKeyMin)
  AND (@migrateSrcKeyMax IS NULL OR CAST([Exam_ID] AS BIGINT) <= @migrateSrcKeyMax)`;

/** keyset: ดึงเฉพาะ Exam_ID (ขั้นที่ 1 — แบบ examination) */
export const MSSQL_BILLING_ID_SELECT = `
SELECT TOP (@page)
  CAST([Exam_ID] AS BIGINT) AS exam_id
FROM {{sourceObject}}
WHERE [Exam_ID] > @afterExamId
  ${BILLING_KEY_RANGE}
ORDER BY [Exam_ID] ASC
`.trim();

/** ดึงรายละเอียดตามรายการ Exam_ID (ขั้นที่ 2) */
export const MSSQL_BILLING_DETAIL_BY_IDS_SELECT = `
SELECT
  ${buildBillingSelectColumns()}
FROM {{sourceObject}}
WHERE CAST([Exam_ID] AS BIGINT) IN ({{idPlaceholders}})
ORDER BY [Exam_ID] ASC
`.trim();

/**
 * คิวรีเดียว (opt-in เท่านั้น — migration.mssqlOptimizeSingleQuery: true)
 * ปกติใช้ probe + IN แทน เพราะเร็วกว่าบน MSSQL ไกล
 */
export const MSSQL_BILLING_KEYSET_SELECT = `
SELECT TOP (@page)
${buildBillingSelectColumns()}
FROM {{sourceObject}}
WHERE [Exam_ID] > @afterExamId
  ${BILLING_KEY_RANGE}
ORDER BY [Exam_ID] ASC
`.trim();
