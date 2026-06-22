import { buildExamTwoStepSelectBundle } from "../../shared/js-migrate/mssqlExamTwoStepSelect.mjs";

const EXAMINATION_GENERAL_COLUMNS = `
  CAST(CAST([Exam_ID] AS BIGINT) AS NVARCHAR(MAX)) AS exam_id,
  CONVERT(VARCHAR(30), [Exam_Date], 126) AS exam_date,
  CAST([PID] AS NVARCHAR(MAX)) AS pid,
  CAST([PatientExamType] AS NVARCHAR(MAX)) AS patientexamtype,
  CAST([PatientExamType_Des] AS NVARCHAR(MAX)) AS patientexamtype_des,
  CAST([Screening] AS NVARCHAR(MAX)) AS screening,
  CAST([Screening_Des] AS NVARCHAR(MAX)) AS screening_des,
  CAST([Followup] AS NVARCHAR(MAX)) AS followup,
  CAST([Followup_Des] AS NVARCHAR(MAX)) AS followup_des,
  CAST([r_ProblemIndicated] AS NVARCHAR(MAX)) AS r_problemindicated,
  CAST([r_ProblemIndicated_Des] AS NVARCHAR(MAX)) AS r_problemindicated_des,
  CAST([l_ProblemIndicated] AS NVARCHAR(MAX)) AS l_problemindicated,
  CAST([l_ProblemIndicated_Des] AS NVARCHAR(MAX)) AS l_problemindicated_des,
  CAST([PE] AS NVARCHAR(MAX)) AS pe,
  CAST([PE_Des] AS NVARCHAR(MAX)) AS pe_des,
  CAST([r_Palpable] AS NVARCHAR(MAX)) AS r_palpable,
  CAST([r_Palpable_Des] AS NVARCHAR(MAX)) AS r_palpable_des,
  CAST([l_Palpable] AS NVARCHAR(MAX)) AS l_palpable,
  CAST([l_Palpable_Des] AS NVARCHAR(MAX)) AS l_palpable_des,
  CAST([Assessment_BIRADS] AS NVARCHAR(MAX)) AS assessment_birads,
  CAST([Assessment_BIRADS_Des] AS NVARCHAR(MAX)) AS assessment_birads_des,
  CAST([Recommendation] AS NVARCHAR(MAX)) AS recommendation,
  CAST([Recommendation_Des] AS NVARCHAR(MAX)) AS recommendation_des_text,
  CAST([Recommendation_Followupmonths] AS NVARCHAR(MAX)) AS recommendation_followupmounths,
  CAST([r_Recommendation_Coned_Compression] AS NVARCHAR(MAX)) AS r_recommendation_coned_compression,
  CAST([l_Recommendation_Coned_Compression] AS NVARCHAR(MAX)) AS l_recommendation_coned_compression,
  CAST([r_Recommendation_Spot_Mag] AS NVARCHAR(MAX)) AS r_recommendation_spot_mag,
  CAST([l_Recommendation_Spot_Mag] AS NVARCHAR(MAX)) AS l_recommendation_spot_mag,
  CAST([r_Recommendation_Mag] AS NVARCHAR(MAX)) AS r_recommendation_mag,
  CAST([l_Recommendation_Mag] AS NVARCHAR(MAX)) AS l_recommendation_mag,
  CAST([r_Recommendation_Coned_Compression_Des] AS NVARCHAR(MAX)) AS r_recommendation_coned_compression_des,
  CAST([l_Recommendation_Coned_Compression_Des] AS NVARCHAR(MAX)) AS l_recommendation_coned_compression_des,
  CAST([r_Recommendation_Spot_Mag_Des] AS NVARCHAR(MAX)) AS r_recommendation_spot_mag_des,
  CAST([l_Recommendation_Spot_Mag_Des] AS NVARCHAR(MAX)) AS l_recommendation_spot_mag_des,
  CAST([r_Recommendation_Mag_Des] AS NVARCHAR(MAX)) AS r_recommendation_mag_des,
  CAST([l_Recommendation_Mag_Des] AS NVARCHAR(MAX)) AS l_recommendation_mag_des,
  CAST([Impression] AS NVARCHAR(MAX)) AS impression,
  CAST([Impression_Des] AS NVARCHAR(MAX)) AS impression_des,
  CAST([Impression_LastExaminationDates] AS NVARCHAR(MAX)) AS impression_lastexaminationdates,
  CAST([Radiologist] AS NVARCHAR(MAX)) AS radiologist,
  CAST([SpecialCase] AS NVARCHAR(MAX)) AS specialcase,
  CAST([SpecialCase_Point] AS NVARCHAR(MAX)) AS specialcase_point,
  CAST([SpecialCase_Point_Des] AS NVARCHAR(MAX)) AS specialcase_point_des,
  CAST([SpecialCase_Detail] AS NVARCHAR(MAX)) AS specialcase_detail,
  CAST([Recommendation_Followup_with] AS NVARCHAR(MAX)) AS recommendation_followup_with,
  CAST([IsConvertFromOldSystem] AS NVARCHAR(MAX)) AS isconvertfromoldsystem,
  CAST([Sub_BIRADS] AS NVARCHAR(MAX)) AS sub_birads,
  CAST([FollowupSymptom] AS NVARCHAR(MAX)) AS followupsymptom,
  CAST([FollowupMonths] AS NVARCHAR(MAX)) AS followupmonths,
  CONVERT(VARCHAR(30), [FollowupLetterPrintDate], 126) AS followupletterprintdate,
  CONVERT(VARCHAR(30), [Followup_Date], 126) AS followup_date,
  CAST([Corrected] AS NVARCHAR(MAX)) AS corrected,
  CONVERT(VARCHAR(30), [CorrectedDate], 126) AS correcteddate,
  CAST([r_Followup] AS NVARCHAR(MAX)) AS r_followup,
  CAST([r_Followup_Des] AS NVARCHAR(MAX)) AS r_followup_des,
  CAST([l_Followup] AS NVARCHAR(MAX)) AS l_followup,
  CAST([l_Followup_Des] AS NVARCHAR(MAX)) AS l_followup_des,
  CAST([Cosign] AS NVARCHAR(MAX)) AS cosign
`.trim();

const EXAMINATION_GENERAL_KEY_RANGE = `
(@migrateSrcKeyMin IS NULL OR CAST([Exam_ID] AS BIGINT) >= @migrateSrcKeyMin)
  AND (@migrateSrcKeyMax IS NULL OR CAST([Exam_ID] AS BIGINT) <= @migrateSrcKeyMax)`;

/** @param {string | null | undefined} createdDateColumn */
export function createMssqlExaminationGeneralSelectBundle(createdDateColumn) {
  return buildExamTwoStepSelectBundle({
    createdDateColumn,
    detailColumns: EXAMINATION_GENERAL_COLUMNS,
    keyRangeWhere: EXAMINATION_GENERAL_KEY_RANGE,
  });
}

export const defaultMssqlExaminationGeneralSelectBundle =
  createMssqlExaminationGeneralSelectBundle("CreatedDate");

export const MSSQL_EXAMINATION_GENERAL_ID_SELECT =
  defaultMssqlExaminationGeneralSelectBundle.idProbeSql;
export const MSSQL_EXAMINATION_GENERAL_DETAIL_BY_IDS_SELECT =
  defaultMssqlExaminationGeneralSelectBundle.detailByIdsSql;
