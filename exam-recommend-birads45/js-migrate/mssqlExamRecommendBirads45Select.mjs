import { buildExamRecommendSelectBundle } from "../../shared/js-migrate/mssqlExamTwoStepSelect.mjs";

const EXAM_RECOMMEND_BIRADS45_COLUMNS = `
  CAST(CAST([Exam_ID] AS BIGINT) AS NVARCHAR(MAX)) AS exam_id,
  CONVERT(VARCHAR(30), [Exam_Date], 126) AS exam_date,
  CAST([PID] AS NVARCHAR(MAX)) AS pid,
  CAST(CAST([Recommend_ID] AS INT) AS NVARCHAR(MAX)) AS recommend_id,
  CAST([Biopsy_Procedure] AS NVARCHAR(MAX)) AS biopsy_procedure,
  CAST([Breast_Side] AS NVARCHAR(MAX)) AS breast_side,
  CAST([Location] AS NVARCHAR(MAX)) AS location
`.trim();

const EXAM_RECOMMEND_KEY_RANGE = `
(@migrateSrcKeyMin IS NULL OR CAST([Exam_ID] AS BIGINT) >= @migrateSrcKeyMin)
  AND (@migrateSrcKeyMax IS NULL OR CAST([Exam_ID] AS BIGINT) <= @migrateSrcKeyMax)`;

/** @param {string | null | undefined} createdDateColumn */
export function createMssqlExamRecommendBirads45SelectBundle(createdDateColumn) {
  return buildExamRecommendSelectBundle({
    createdDateColumn,
    detailColumns: EXAM_RECOMMEND_BIRADS45_COLUMNS,
    keyRangeWhere: EXAM_RECOMMEND_KEY_RANGE,
  });
}

export const defaultMssqlExamRecommendBirads45SelectBundle =
  createMssqlExamRecommendBirads45SelectBundle("CreatedDate");

export const MSSQL_EXAM_RECOMMEND_BIRADS45_ID_SELECT =
  defaultMssqlExamRecommendBirads45SelectBundle.idProbeSql;
export const MSSQL_EXAM_RECOMMEND_BIRADS45_DETAIL_BY_IDS_SELECT =
  defaultMssqlExamRecommendBirads45SelectBundle.detailByIdsSql;
