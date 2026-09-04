/** SQL Server จำกัดจำนวน parameter ต่อ request (error 8003) */
export const MSSQL_MAX_IN_PARAMS = 2100;

/**
 * driver (mssql/tedious) ส่ง query ที่มี parameter ผ่าน sp_executesql เสมอ
 * ซึ่งกิน @statement + @params ไปก่อน 2 ตัว → id ที่ผูกได้จริงคือ 2098 ไม่ใช่ 2100
 */
export const MSSQL_SP_EXECUTESQL_RESERVED_PARAMS = 2;

/** จำนวน id สูงสุดที่กางใน IN (...) ได้ต่อ 1 request */
export const MSSQL_MAX_ID_PARAMS =
  MSSQL_MAX_IN_PARAMS - MSSQL_SP_EXECUTESQL_RESERVED_PARAMS;

/**
 * clamp ขนาด chunk ของ IN list ไม่ให้ทะลุเพดาน parameter
 *
 * @param {number} size ขนาดที่อยากได้ (เช่น batchSize)
 * @param {number} [extraParams] parameter อื่นที่ผูกใน request เดียวกันกับ IN list
 * @returns {number}
 */
export function clampMssqlIdChunkSize(size, extraParams = 0) {
  const cap = Math.max(1, MSSQL_MAX_ID_PARAMS - Math.max(0, extraParams));
  const n = Number(size);
  if (!Number.isFinite(n) || n < 1) return cap;
  return Math.min(Math.floor(n), cap);
}

/**
 * @param {import("mssql").ConnectionPool} pool
 * @param {typeof import("mssql")} sqlPkg
 * @param {{
 *   ids: string[] | number[],
 *   detailSqlTemplate: string,
 *   idType?: 'bigint' | 'nvarchar',
 *   nvarcharLength?: number,
 * }} options
 */
async function fetchMssqlRowsByIdsOnce(
  pool,
  sqlPkg,
  { ids, detailSqlTemplate, idType = "bigint", nvarcharLength = 100 },
) {
  if (!ids?.length) return [];
  const idPlaceholders = ids.map((_, i) => `@id${i}`).join(", ");
  const detailSql = detailSqlTemplate.replace(
    "{{idPlaceholders}}",
    idPlaceholders,
  );
  const detailReq = pool.request();
  ids.forEach((id, i) => {
    if (idType === "nvarchar") {
      detailReq.input(`id${i}`, sqlPkg.NVarChar(nvarcharLength), String(id));
    } else {
      const n = Number.parseInt(String(id), 10);
      detailReq.input(
        `id${i}`,
        sqlPkg.BigInt,
        Number.isFinite(n) ? n : BigInt(String(id)),
      );
    }
  });
  const detailRes = await detailReq.query(detailSql);
  return detailRes.recordset ?? [];
}

/**
 * ดึงแถวจาก MSSQL ตามรายการ id (แบ่ง sub-batch อัตโนมัติถ้าเกิน limit parameter)
 *
 * @param {import("mssql").ConnectionPool} pool
 * @param {typeof import("mssql")} sqlPkg
 * @param {{
 *   ids: string[] | number[],
 *   detailSqlTemplate: string,
 *   idType?: 'bigint' | 'nvarchar',
 *   nvarcharLength?: number,
 *   maxParamsPerRequest?: number,
 * }} options
 */
export async function fetchMssqlRowsByIds(
  pool,
  sqlPkg,
  {
    ids,
    detailSqlTemplate,
    idType = "bigint",
    nvarcharLength = 100,
    maxParamsPerRequest = MSSQL_MAX_ID_PARAMS,
  },
) {
  if (!ids?.length) return [];
  const cap = clampMssqlIdChunkSize(maxParamsPerRequest);
  if (ids.length <= cap) {
    return fetchMssqlRowsByIdsOnce(pool, sqlPkg, {
      ids,
      detailSqlTemplate,
      idType,
      nvarcharLength,
    });
  }

  /** @type {object[]} */
  const rows = [];
  for (let i = 0; i < ids.length; i += cap) {
    const slice = ids.slice(i, i + cap);
    const part = await fetchMssqlRowsByIdsOnce(pool, sqlPkg, {
      ids: slice,
      detailSqlTemplate,
      idType,
      nvarcharLength,
    });
    rows.push(...part);
  }
  return rows;
}
