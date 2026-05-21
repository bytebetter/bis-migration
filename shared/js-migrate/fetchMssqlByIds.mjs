/**
 * ดึงแถวจาก MSSQL ตามรายการ id
 *
 * @param {import("mssql").ConnectionPool} pool
 * @param {typeof import("mssql")} sqlPkg
 * @param {{
 *   ids: string[],
 *   detailSqlTemplate: string,
 *   idType?: 'bigint' | 'nvarchar',
 *   nvarcharLength?: number,
 * }} options
 */
export async function fetchMssqlRowsByIds(
  pool,
  sqlPkg,
  { ids, detailSqlTemplate, idType = "bigint", nvarcharLength = 100 },
) {
  if (!ids?.length) return [];
  const idPlaceholders = ids.map((_, i) => `@id${i}`).join(", ");
  const detailSql = detailSqlTemplate.replace("{{idPlaceholders}}", idPlaceholders);
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
