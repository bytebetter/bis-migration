/**
 * อ่านจาก MSSQL (patient_info) แล้วใส่ migrate_stg.patient_info_mssql -> รัน sql/02_insert_into_clone_patient_info.sql
 * ไม่ต้องวางไฟล์ CSV ใน imports/
 *
 * ต้องการ: Node 20+, ในโฟลเดอร์นี้รัน `npm install`
 *
 * ตัวอย่าง PowerShell:
 *   $env:MSSQL_SERVER="your-host"
 *   $env:MSSQL_DATABASE="YourDb"
 *   $env:MSSQL_USER="sa"
 *   $env:MSSQL_PASSWORD="..."
 *   $env:MSSQL_TRUST_CERT="true"
 *
 *   $env:POSTGRES_HOST="127.0.0.1"
 *   $env:POSTGRES_PORT="5432"
 *   $env:POSTGRES_USER="devuser"
 *   $env:POSTGRES_PASSWORD="..."
 *   $env:POSTGRES_DATABASE="bisinfo_dev_clone"
 *
 *   $env:TRUNCATE_PATIENT_FIRST="true"   # optional
 *   npm run migrate
 *
 * Postgres ให้เข้าถึงจากเครื่องคุณ (เช่น kubectl port-forward svc/postgresql 5432:5432)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function env(name, fallback = "") {
  const v = process.env[name];
  return v == null || v === "" ? fallback : v;
}

function toStr(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d} 00:00:00.000`;
  }
  return String(v);
}

function rowToStagingArrays(row, rowIdx, arrays, cols) {
  const g = (k) => {
    const v = row[k] ?? row[k.toLowerCase()] ?? row[k.toUpperCase()];
    return v === undefined || v === null ? null : toStr(v);
  };
  for (let c = 0; c < cols.length; c++) {
    arrays[c][rowIdx] = g(cols[c]);
  }
}

async function main() {
  const batchSize = Math.max(50, Math.min(5000, Number(env("BATCH_SIZE", "500")) || 500));

  const mssqlConfig = {
    server: env("MSSQL_SERVER"),
    database: env("MSSQL_DATABASE"),
    user: env("MSSQL_USER"),
    password: env("MSSQL_PASSWORD"),
    options: {
      encrypt: env("MSSQL_ENCRYPT", "true") === "true",
      trustServerCertificate: env("MSSQL_TRUST_CERT", "false") === "true",
    },
    pool: { max: 5, min: 0 },
  };

  if (!mssqlConfig.server || !mssqlConfig.database) {
    throw new Error("ตั้ง MSSQL_SERVER และ MSSQL_DATABASE");
  }
  if (!mssqlConfig.user) {
    throw new Error("ตั้ง MSSQL_USER / MSSQL_PASSWORD (ปรับสคริปต์เองถ้าต้องการ Windows Auth)");
  }

  const sqlDir = path.join(__dirname, "..", "sql");
  const ddl = fs.readFileSync(path.join(sqlDir, "01_create_staging.sql"), "utf8");
  const insertTarget = fs.readFileSync(path.join(sqlDir, "02_insert_into_clone_patient_info.sql"), "utf8");
  const truncateSql = fs.readFileSync(path.join(sqlDir, "00_truncate_clone_patient_info.sql"), "utf8");

  const cols = [
    "pid",
    "prefix",
    "name",
    "surname",
    "date_of_birth_be",
    "single",
    "address",
    "sub_area",
    "area",
    "province",
    "zip",
    "phone_biz",
    "phone_home",
    "height",
    "weight",
    "current_breast_compo",
    "current_implant_type",
    "last_exam_date",
    "mobile",
    "mobile_updated",
    "donate_type",
    "eng_prefix",
    "eng_name",
    "eng_surname",
    "soc_id",
    "hn",
    "gender",
    "address2",
    "short_note",
    "disease",
    "mobile_phone",
    "email",
  ];

  const mssqlSelectBody = `
SELECT
  CAST([PID] AS NVARCHAR(MAX)) AS pid,
  CAST([Prefix] AS NVARCHAR(MAX)) AS prefix,
  CAST([Name] AS NVARCHAR(MAX)) AS [name],
  CAST([Surname] AS NVARCHAR(MAX)) AS surname,
  CONVERT(VARCHAR(30), [DateOfBirth], 126) AS date_of_birth_be,
  CAST([Single] AS NVARCHAR(MAX)) AS single,
  CAST([Address] AS NVARCHAR(MAX)) AS address,
  CAST([SubArea] AS NVARCHAR(MAX)) AS sub_area,
  CAST([Area] AS NVARCHAR(MAX)) AS area,
  CAST([Province] AS NVARCHAR(MAX)) AS province,
  CAST([Zip] AS NVARCHAR(MAX)) AS zip,
  CAST([Phone_BIZ] AS NVARCHAR(MAX)) AS phone_biz,
  CAST([Phone_Home] AS NVARCHAR(MAX)) AS phone_home,
  CAST(CAST([Height] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS height,
  CAST(CAST([Weight] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS weight,
  CAST([Current_Breast_Compo] AS NVARCHAR(MAX)) AS current_breast_compo,
  CAST([Current_implant_Type] AS NVARCHAR(MAX)) AS current_implant_type,
  CONVERT(VARCHAR(30), [LastExamDate], 126) AS last_exam_date,
  CAST([Mobile] AS NVARCHAR(MAX)) AS mobile,
  CONVERT(VARCHAR(30), [MobileUpdated], 126) AS mobile_updated,
  CAST(CAST([Donate_Type] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS donate_type,
  CAST([EngPrefix] AS NVARCHAR(MAX)) AS eng_prefix,
  CAST([EngName] AS NVARCHAR(MAX)) AS eng_name,
  CAST([EngSurname] AS NVARCHAR(MAX)) AS eng_surname,
  CAST([SocID] AS NVARCHAR(MAX)) AS soc_id,
  CAST([HN] AS NVARCHAR(MAX)) AS hn,
  CAST([Gender] AS NVARCHAR(MAX)) AS gender,
  CAST([Address2] AS NVARCHAR(MAX)) AS address2,
  CAST([ShortNote] AS NVARCHAR(MAX)) AS short_note,
  CAST([Disease] AS NVARCHAR(MAX)) AS disease,
  CAST([Mobile_Phone] AS NVARCHAR(MAX)) AS mobile_phone,
  CAST([Email] AS NVARCHAR(MAX)) AS email
FROM dbo.patient_info
ORDER BY [PID]
OFFSET @offset ROWS FETCH NEXT @page ROWS ONLY;
`;

  const pgPool = new pg.Pool({
    host: env("POSTGRES_HOST", "127.0.0.1"),
    port: Number(env("POSTGRES_PORT", "5432")),
    user: env("POSTGRES_USER"),
    password: env("POSTGRES_PASSWORD"),
    database: env("POSTGRES_DATABASE", "bisinfo_dev_clone"),
    max: 5,
  });

  const pool = await sql.connect(mssqlConfig);
  try {
    const client = await pgPool.connect();
    try {
      if (env("TRUNCATE_PATIENT_FIRST", "") === "true") {
        console.error(">>> TRUNCATE public.patient_info (clone) ...");
        await client.query(truncateSql);
      }

      console.error(">>> สร้าง staging (01) ...");
      await client.query(ddl);

      console.error(">>> ดึงจาก MSSQL แบบแบ่งหน้า แล้ว bulk insert staging ...");
      let offset = 0;
      let total = 0;

      while (true) {
        const r = await pool
          .request()
          .input("offset", sql.Int, offset)
          .input("page", sql.Int, batchSize)
          .query(mssqlSelectBody);

        const rows = r.recordset || [];
        if (rows.length === 0) break;

        const n = rows.length;
        const arrays = cols.map(() => new Array(n));
        for (let i = 0; i < n; i++) {
          rowToStagingArrays(rows[i], i, arrays, cols);
        }

        const unnestArgs = arrays.map((_, idx) => `$${idx + 1}::text[]`).join(", ");
        const colList = cols.join(", ");
        const insertStaging = `
INSERT INTO migrate_stg.patient_info_mssql (${colList})
SELECT * FROM unnest(${unnestArgs});
`;
        await client.query(insertStaging, arrays);

        total += n;
        console.error(`    ... ${total} แถว (staging)`);
        if (rows.length < batchSize) break;
        offset += batchSize;
      }

      console.error(">>> แปลงเข้า public.patient_info (02) ...");
      await client.query(insertTarget);

      console.error(`เสร็จแล้ว รวม ~${total} แถวจาก MSSQL (ตามจำนวนแถวที่อ่านได้ต่อรอบ)`);
    } finally {
      client.release();
    }
  } finally {
    await pool.close();
    await pgPool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
