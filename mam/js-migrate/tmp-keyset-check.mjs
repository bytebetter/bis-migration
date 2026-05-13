import fs from "node:fs";
import sql from "mssql";
import { MSSQL_MAM_ID_SELECT } from "./mssqlMamSelect.mjs";

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
      .query("SELECT COUNT_BIG(1) AS c FROM dbo.mammogram WITH (NOLOCK)")
  ).recordset[0].c,
);
const sqlText = MSSQL_MAM_ID_SELECT.replaceAll(
  "{{sourceObject}}",
  "dbo.mammogram WITH (NOLOCK)",
);

let afterExamId = 0;
let total = 0;
while (true) {
  const res = await pool
    .request()
    .input("afterExamId", sql.BigInt, afterExamId)
    .input("page", sql.Int, 2000)
    .query(sqlText);
  const rows = res.recordset ?? [];
  if (rows.length === 0) break;
  total += rows.length;
  afterExamId = Number(rows[rows.length - 1].exam_id);
  if (rows.length < 2000) break;
}

console.log(JSON.stringify({ table: "mam", count, total, afterExamId }));
await pool.close();
