import { buildExamTwoStepSelectBundle } from "../../shared/js-migrate/mssqlExamTwoStepSelect.mjs";

const ULTRASOUND_COLUMNS = `
  CAST(CAST([Exam_ID] AS BIGINT) AS NVARCHAR(MAX)) AS exam_id,
  CONVERT(VARCHAR(30), [Exam_Date], 126) AS exam_date,
  CAST([PID] AS NVARCHAR(MAX)) AS pid,
  CAST([Mass] AS NVARCHAR(MAX)) AS mass,
  CAST([Mass_Des] AS NVARCHAR(MAX)) AS mass_des,
  CAST([Num_of_Mass_Found] AS NVARCHAR(MAX)) AS num_of_mass_found,
  CAST([Num_of_Mass_ActualFound] AS NVARCHAR(MAX)) AS num_of_mass_actualfound,
  CAST([Cyst] AS NVARCHAR(MAX)) AS cyst,
  CAST([Cyst_Des] AS NVARCHAR(MAX)) AS cyst_des,
  CAST([Num_of_Cyst_Found] AS NVARCHAR(MAX)) AS num_of_cyst_found,
  CAST([Num_of_Cyst_ActualFound] AS NVARCHAR(MAX)) AS num_of_cyst_actualfound,
  CAST([TissueComposition] AS NVARCHAR(MAX)) AS tissuecomposition,
  CAST([TissueComposition_Des] AS NVARCHAR(MAX)) AS tissuecomposition_des,
  CAST([r_AssociatedFeatures] AS NVARCHAR(MAX)) AS r_associatedfeatures,
  CAST([r_AssociatedFeatures_Des] AS NVARCHAR(MAX)) AS r_associatedfeatures_des,
  CAST([l_AssociatedFeatures] AS NVARCHAR(MAX)) AS l_associatedfeatures,
  CAST([l_AssociatedFeatures_Des] AS NVARCHAR(MAX)) AS l_associatedfeatures_des,
  CAST([r_SpecialCase] AS NVARCHAR(MAX)) AS r_specialcase,
  CAST([r_SpecialCase_Des] AS NVARCHAR(MAX)) AS r_specialcase_des,
  CAST([l_SpecialCase] AS NVARCHAR(MAX)) AS l_specialcase,
  CAST([l_SpecialCase_Des] AS NVARCHAR(MAX)) AS l_specialcase_des,
  CAST([Technique] AS NVARCHAR(MAX)) AS technique,
  CAST([Technique_Des] AS NVARCHAR(MAX)) AS technique_des
`.trim();

const ULTRASOUND_KEY_RANGE = `
(@migrateSrcKeyMin IS NULL OR CAST([Exam_ID] AS BIGINT) >= @migrateSrcKeyMin)
  AND (@migrateSrcKeyMax IS NULL OR CAST([Exam_ID] AS BIGINT) <= @migrateSrcKeyMax)`;

/** @param {string | null | undefined} createdDateColumn */
export function createMssqlUltrasoundSelectBundle(createdDateColumn) {
  return buildExamTwoStepSelectBundle({
    createdDateColumn,
    detailColumns: ULTRASOUND_COLUMNS,
    keyRangeWhere: ULTRASOUND_KEY_RANGE,
  });
}

export const defaultMssqlUltrasoundSelectBundle =
  createMssqlUltrasoundSelectBundle("CreatedDate");

export const MSSQL_ULTRASOUND_ID_SELECT =
  defaultMssqlUltrasoundSelectBundle.idProbeSql;
export const MSSQL_ULTRASOUND_DETAIL_BY_IDS_SELECT =
  defaultMssqlUltrasoundSelectBundle.detailByIdsSql;
