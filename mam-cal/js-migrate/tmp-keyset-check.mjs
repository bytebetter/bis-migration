import fs from "node:fs";
import sql from "mssql";
import { MSSQL_MAM_CAL_KEYSET_SELECT } from "./mssqlMamCalSelect.mjs";
import { bindMssqlSourceObjectPlaceholders } from "../../shared/js-migrate/mssqlExamTwoStepSelect.mjs";

const cfg = JSON.parse(
  fs.readFileSync("../../migration.config.local.json", "utf8"),
);
const s = cfg.shared.source;
const pool = await sql.connect({
  server: s.server,
  port: s.port,
  database: s.database,
  user: s.user,
  password: s.password,
  options: {
    encrypt: s.encrypt,
    trustServerCertificate: s.trustServerCertificate,
  },
  requestTimeout: 0,
  connectionTimeout: s.connectTimeout ?? 60000,
});

const count = Number(
  (
    await pool
      .request()
      .query("SELECT COUNT_BIG(1) AS c FROM dbo.mammogram_cal WITH (NOLOCK)")
  ).recordset[0].c,
);
const sqlText = bindMssqlSourceObjectPlaceholders(
  MSSQL_MAM_CAL_KEYSET_SELECT,
  "dbo.mammogram_cal",
);

let afterExamId = 0;
let afterChildId = 0;
let total = 0;
while (true) {
  const res = await pool
    .request()
    .input("afterExamId", sql.BigInt, afterExamId)
    .input("afterChildId", sql.Int, afterChildId)
    .input("page", sql.Int, 2000)
    .query(sqlText);
  const rows = res.recordset ?? [];
  if (rows.length === 0) break;
  total += rows.length;
  const last = rows[rows.length - 1];
  afterExamId = Number.parseInt(last.exam_id ?? "", 10);
  afterChildId = Number.parseInt(last.described_cal_id ?? "", 10);
  if (rows.length < 2000) break;
}

console.log(
  JSON.stringify({ table: "mam_cal", count, total, afterExamId, afterChildId }),
);
await pool.close();
