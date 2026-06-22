import { buildExamTwoStepSelectBundle } from "../../shared/js-migrate/mssqlExamTwoStepSelect.mjs";

const MAM_COLUMNS = `
  CAST(CAST([Exam_ID] AS BIGINT) AS NVARCHAR(MAX)) AS exam_id,
  CONVERT(VARCHAR(30), [Exam_Date], 126) AS exam_date,
  CAST([PID] AS NVARCHAR(MAX)) AS pid,
  CAST([BreastComposition] AS NVARCHAR(MAX)) AS breastcomposition,
  CAST([BreastComposition_Des] AS NVARCHAR(MAX)) AS breastcomposition_des,
  CAST([Implant] AS NVARCHAR(MAX)) AS implant,
  CAST([Implant_Des] AS NVARCHAR(MAX)) AS implant_des,
  CAST([Implant_Finding] AS NVARCHAR(MAX)) AS implant_finding,
  CAST([Implant_Finding_Des] AS NVARCHAR(MAX)) AS implant_finding_des,
  CAST([Technique] AS NVARCHAR(MAX)) AS technique,
  CAST([r_technique] AS NVARCHAR(MAX)) AS r_technique,
  CAST([l_technique] AS NVARCHAR(MAX)) AS l_technique,
  CAST([Technique_Des] AS NVARCHAR(MAX)) AS technique_des,
  CAST([Mass] AS NVARCHAR(MAX)) AS mass,
  CAST([Mass_Des] AS NVARCHAR(MAX)) AS mass_des,
  CAST([Num_of_Mass_ActualFound] AS NVARCHAR(MAX)) AS num_of_mass_actualfound,
  CAST([Cal] AS NVARCHAR(MAX)) AS cal,
  CAST([Cal_Des] AS NVARCHAR(MAX)) AS cal_des,
  CAST([Num_of_Cal_ActualFound] AS NVARCHAR(MAX)) AS num_of_cal_actualfound,
  CAST([r_AddProc_Mag] AS NVARCHAR(MAX)) AS r_addproc_mag,
  CAST([l_AddProc_Mag] AS NVARCHAR(MAX)) AS l_addproc_mag,
  CAST([r_AddProc_Spot_Mag] AS NVARCHAR(MAX)) AS r_addproc_spot_mag,
  CAST([l_AddProc_Spot_Mag] AS NVARCHAR(MAX)) AS l_addproc_spot_mag,
  CAST([r_AddProc_Coned_Compression] AS NVARCHAR(MAX)) AS r_addproc_coned_compression,
  CAST([l_AddProc_Coned_Compression] AS NVARCHAR(MAX)) AS l_addproc_coned_compression,
  CAST([r_AddProc_Coned_Exag_CC] AS NVARCHAR(MAX)) AS r_addproc_coned_exag_cc,
  CAST([l_AddProc_Coned_Exag_CC] AS NVARCHAR(MAX)) AS l_addproc_coned_exag_cc,
  CAST([r_AddProc_Other] AS NVARCHAR(MAX)) AS r_addproc_other,
  CAST([l_AddProc_Other] AS NVARCHAR(MAX)) AS l_addproc_other,
  CAST([r_AddProc_Other_Des] AS NVARCHAR(MAX)) AS r_addproc_other_des,
  CAST([l_AddProc_Other_Des] AS NVARCHAR(MAX)) AS l_addproc_other_des,
  CAST([r_specialcase] AS NVARCHAR(MAX)) AS r_specialcase,
  CAST([r_specialcase_Des] AS NVARCHAR(MAX)) AS r_specialcase_des,
  CAST([l_specialcase] AS NVARCHAR(MAX)) AS l_specialcase,
  CAST([l_specialcase_Des] AS NVARCHAR(MAX)) AS l_specialcase_des,
  CAST([r_AssFinding] AS NVARCHAR(MAX)) AS r_assfinding,
  CAST([r_AssFinding_Des] AS NVARCHAR(MAX)) AS r_assfinding_des,
  CAST([l_AssFinding] AS NVARCHAR(MAX)) AS l_assfinding,
  CAST([l_AssFinding_Des] AS NVARCHAR(MAX)) AS l_assfinding_des,
  CAST([IsConvertFromOldSystem] AS NVARCHAR(MAX)) AS isconvertfromoldsystem,
  CAST([l_Implant] AS NVARCHAR(MAX)) AS l_implant,
  CAST([l_Implant_Des] AS NVARCHAR(MAX)) AS l_implant_des,
  CAST([l_Implant_Finding] AS NVARCHAR(MAX)) AS l_implant_finding,
  CAST([l_Implant_Finding_Des] AS NVARCHAR(MAX)) AS l_implant_finding_des
`.trim();

const MAM_KEY_RANGE = `
(@migrateSrcKeyMin IS NULL OR CAST([Exam_ID] AS BIGINT) >= @migrateSrcKeyMin)
  AND (@migrateSrcKeyMax IS NULL OR CAST([Exam_ID] AS BIGINT) <= @migrateSrcKeyMax)`;

/** @param {string | null | undefined} createdDateColumn */
export function createMssqlMamSelectBundle(createdDateColumn) {
  return buildExamTwoStepSelectBundle({
    createdDateColumn,
    detailColumns: MAM_COLUMNS,
    keyRangeWhere: MAM_KEY_RANGE,
  });
}

export const defaultMssqlMamSelectBundle = createMssqlMamSelectBundle("CreatedDate");

export const MSSQL_MAM_ID_SELECT = defaultMssqlMamSelectBundle.idProbeSql;
export const MSSQL_MAM_DETAIL_BY_IDS_SELECT =
  defaultMssqlMamSelectBundle.detailByIdsSql;
