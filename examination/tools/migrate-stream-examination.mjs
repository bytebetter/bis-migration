/**
 * อ่านจาก MSSQL (examination) -> migrate_stg.examination_mssql แล้วรัน sql/02_insert_into_clone_examination.sql
 *
 * ต้องการ: Node 20+, ในโฟลเดอร์นี้รัน `npm install`
 *
 * ตัวอย่าง PowerShell (ค่า env เหมือน patient-info/tools):
 *   $env:MSSQL_SERVER="..."
 *   $env:MSSQL_DATABASE="..."
 *   $env:MSSQL_USER="..."
 *   $env:MSSQL_PASSWORD="..."
 *   $env:MSSQL_TRUST_CERT="true"
 *   $env:POSTGRES_HOST="127.0.0.1"
 *   $env:POSTGRES_PORT="5432"
 *   $env:POSTGRES_USER="devuser"
 *   $env:POSTGRES_PASSWORD="..."
 *   $env:POSTGRES_DATABASE="bisinfo_dev_clone"
 *   $env:TRUNCATE_EXAMINATION_FIRST="true"   # optional
 *   npm run migrate
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
    const hh = String(v.getHours()).padStart(2, "0");
    const mi = String(v.getMinutes()).padStart(2, "0");
    const ss = String(v.getSeconds()).padStart(2, "0");
    return `${y}-${m}-${d} ${hh}:${mi}:${ss}.000`;
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

function tsForFile(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function writeMigrationReport(reportDir, summary, missingRows) {
  fs.mkdirSync(reportDir, { recursive: true });
  const stamp = tsForFile();
  const jsonPath = path.join(
    reportDir,
    `examination-migrate-summary-${stamp}.json`,
  );
  const missingPath = path.join(
    reportDir,
    `examination-migrate-missing-${stamp}.txt`,
  );

  fs.writeFileSync(
    jsonPath,
    JSON.stringify({ ...summary, missingRecords: missingRows }, null, 2),
    "utf8",
  );

  const missingLines = [
    "# exam_id\treason",
    ...missingRows.map((r) => `${r.exam_id ?? ""}\t${r.reason ?? "unknown"}`),
  ];
  fs.writeFileSync(missingPath, `${missingLines.join("\n")}\n`, "utf8");

  return { jsonPath, missingPath };
}

async function main() {
  const batchSize = Math.max(
    50,
    Math.min(5000, Number(env("BATCH_SIZE", "500")) || 500),
  );
  const reportDir = env(
    "MIGRATE_REPORT_DIR",
    path.join(__dirname, "..", "reports"),
  );

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
    throw new Error("ตั้ง MSSQL_USER / MSSQL_PASSWORD");
  }

  const sqlDir = path.join(__dirname, "..", "sql");
  const ddl = fs.readFileSync(
    path.join(sqlDir, "01_create_staging.sql"),
    "utf8",
  );
  const insertTarget = fs.readFileSync(
    path.join(sqlDir, "02_insert_into_clone_examination.sql"),
    "utf8",
  );
  const truncateSql = fs.readFileSync(
    path.join(sqlDir, "00_truncate_clone_examination.sql"),
    "utf8",
  );

  const cols = [
    "exam_id",
    "exam_date",
    "pid",
    "tech_login_name",
    "mobile",
    "mobile_update",
    "menstruation_age",
    "menopause_age",
    "first_pregnancy_age",
    "num_pregnancy",
    "cont_use",
    "cont_yrs",
    "hormone_use",
    "hormone_yrs",
    "hysterectomy",
    "ovaries_removed",
    "pragnant",
    "referring_md",
    "referring_hospital",
    "prev_mammo_date",
    "prev_mammo_loc",
    "sister_cancer_age",
    "mother_cancer_age",
    "grandmother_cancer_age",
    "other_cancer_age",
    "biopsy_l_date",
    "biopsy_r_date",
    "chemo_l_date",
    "chemo_r_date",
    "cyst_l_date",
    "cyst_r_date",
    "irr_l_date",
    "irr_r_date",
    "lump_l_date",
    "lump_r_date",
    "mast_l_date",
    "mast_r_date",
    "rad_l_date",
    "rad_r_date",
    "num_left_mass",
    "num_right_mass",
    "lnwn",
    "lnww",
    "ln",
    "lnen",
    "lnee",
    "le",
    "lm",
    "lw",
    "lsws",
    "lsww",
    "ls",
    "lses",
    "lsee",
    "rnwn",
    "rnww",
    "rn",
    "rnen",
    "rnee",
    "re",
    "rm",
    "rw",
    "rsws",
    "rsww",
    "rs",
    "rses",
    "rsee",
    "lother",
    "rother",
    "l_axillar",
    "r_axillar",
    "exam_reason",
    "exam_reason_text",
    "exam_reason_memotext",
    "pain_l_duration",
    "pain_r_duration",
    "mobile_updated",
    "mobile_loc",
    "bct_r_date",
    "bct_l_date",
    "patient_cancer_age",
    "daughter_cancer_age",
    "daughter_cancer_age_more",
    "sister_cancer_age_more",
    "other_cancer_age_more",
    "stophormone_yrs",
    "ca_hormone_use",
    "ca_hormone_yrs",
    "stop_ca_hormone_yrs",
    "stop_contr_yrs",
    "rm_l_date",
    "rm_r_date",
    "ri_l_date",
    "ri_r_date",
    "fna_l_date",
    "fna_r_date",
    "fnx_l_date",
    "fnx_r_date",
    "send_exam_login_name",
    "schedule_id",
  ];

  const mssqlSelectBody = `
SELECT
  CAST(CAST([Exam_ID] AS BIGINT) AS NVARCHAR(MAX)) AS exam_id,
  CONVERT(VARCHAR(30), [Exam_date], 126) AS exam_date,
  CAST([PID] AS NVARCHAR(MAX)) AS pid,
  CAST([Tech_LoginName] AS NVARCHAR(MAX)) AS tech_login_name,
  CAST([mobile] AS NVARCHAR(MAX)) AS mobile,
  CAST([mobile_update] AS NVARCHAR(MAX)) AS mobile_update,
  CAST(CAST([menstruation_age] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS menstruation_age,
  CAST(CAST([menopause_age] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS menopause_age,
  CAST(CAST([first_pregnancy_age] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS first_pregnancy_age,
  CAST(CAST([num_pregnancy] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS num_pregnancy,
  CAST([cont_use] AS NVARCHAR(MAX)) AS cont_use,
  CAST(CAST([cont_yrs] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS cont_yrs,
  CAST([hormone_use] AS NVARCHAR(MAX)) AS hormone_use,
  CAST(CAST([hormone_yrs] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS hormone_yrs,
  CAST([hysterectomy] AS NVARCHAR(MAX)) AS hysterectomy,
  CAST([ovaries_removed] AS NVARCHAR(MAX)) AS ovaries_removed,
  CAST([Pragnant] AS NVARCHAR(MAX)) AS pragnant,
  CAST([Referring_MD] AS NVARCHAR(MAX)) AS referring_md,
  CAST([Referring_Hospital] AS NVARCHAR(MAX)) AS referring_hospital,
  CONVERT(VARCHAR(30), [prev_mammo_date], 126) AS prev_mammo_date,
  CAST([prev_mammo_loc] AS NVARCHAR(MAX)) AS prev_mammo_loc,
  CAST(CAST([sister_cancer_age] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS sister_cancer_age,
  CAST(CAST([mother_cancer_age] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS mother_cancer_age,
  CAST(CAST([grandmother_cancer_age] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS grandmother_cancer_age,
  CAST(CAST([other_cancer_age] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS other_cancer_age,
  CONVERT(VARCHAR(30), [biopsy_l_date], 126) AS biopsy_l_date,
  CONVERT(VARCHAR(30), [biopsy_r_date], 126) AS biopsy_r_date,
  CONVERT(VARCHAR(30), [chemo_l_date], 126) AS chemo_l_date,
  CONVERT(VARCHAR(30), [chemo_r_date], 126) AS chemo_r_date,
  CONVERT(VARCHAR(30), [cyst_l_date], 126) AS cyst_l_date,
  CONVERT(VARCHAR(30), [cyst_r_date], 126) AS cyst_r_date,
  CONVERT(VARCHAR(30), [irr_l_date], 126) AS irr_l_date,
  CONVERT(VARCHAR(30), [irr_r_date], 126) AS irr_r_date,
  CONVERT(VARCHAR(30), [lump_l_date], 126) AS lump_l_date,
  CONVERT(VARCHAR(30), [lump_r_date], 126) AS lump_r_date,
  CONVERT(VARCHAR(30), [mast_l_date], 126) AS mast_l_date,
  CONVERT(VARCHAR(30), [mast_r_date], 126) AS mast_r_date,
  CONVERT(VARCHAR(30), [rad_l_date], 126) AS rad_l_date,
  CONVERT(VARCHAR(30), [rad_r_date], 126) AS rad_r_date,
  CAST(CAST([num_left_mass] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS num_left_mass,
  CAST(CAST([num_right_mass] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS num_right_mass,
  CAST([lnwn] AS NVARCHAR(MAX)) AS lnwn,
  CAST([lnww] AS NVARCHAR(MAX)) AS lnww,
  CAST([ln] AS NVARCHAR(MAX)) AS ln,
  CAST([lnen] AS NVARCHAR(MAX)) AS lnen,
  CAST([lnee] AS NVARCHAR(MAX)) AS lnee,
  CAST([le] AS NVARCHAR(MAX)) AS le,
  CAST([lm] AS NVARCHAR(MAX)) AS lm,
  CAST([lw] AS NVARCHAR(MAX)) AS lw,
  CAST([lsws] AS NVARCHAR(MAX)) AS lsws,
  CAST([lsww] AS NVARCHAR(MAX)) AS lsww,
  CAST([ls] AS NVARCHAR(MAX)) AS ls,
  CAST([lses] AS NVARCHAR(MAX)) AS lses,
  CAST([lsee] AS NVARCHAR(MAX)) AS lsee,
  CAST([rnwn] AS NVARCHAR(MAX)) AS rnwn,
  CAST([rnww] AS NVARCHAR(MAX)) AS rnww,
  CAST([rn] AS NVARCHAR(MAX)) AS rn,
  CAST([rnen] AS NVARCHAR(MAX)) AS rnen,
  CAST([rnee] AS NVARCHAR(MAX)) AS rnee,
  CAST([re] AS NVARCHAR(MAX)) AS re,
  CAST([rm] AS NVARCHAR(MAX)) AS rm,
  CAST([rw] AS NVARCHAR(MAX)) AS rw,
  CAST([rsws] AS NVARCHAR(MAX)) AS rsws,
  CAST([rsww] AS NVARCHAR(MAX)) AS rsww,
  CAST([rs] AS NVARCHAR(MAX)) AS rs,
  CAST([rses] AS NVARCHAR(MAX)) AS rses,
  CAST([rsee] AS NVARCHAR(MAX)) AS rsee,
  CAST([lother] AS NVARCHAR(MAX)) AS lother,
  CAST([rother] AS NVARCHAR(MAX)) AS rother,
  CAST([lAxillar] AS NVARCHAR(MAX)) AS l_axillar,
  CAST([rAxillar] AS NVARCHAR(MAX)) AS r_axillar,
  CAST([Exam_Reason] AS NVARCHAR(MAX)) AS exam_reason,
  CAST([Exam_Reason_text] AS NVARCHAR(MAX)) AS exam_reason_text,
  CAST([Exam_Reason_Memotext] AS NVARCHAR(MAX)) AS exam_reason_memotext,
  CAST(CAST([Pain_l_duration] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS pain_l_duration,
  CAST(CAST([Pain_r_duration] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS pain_r_duration,
  CONVERT(VARCHAR(30), [MobileUpdated], 126) AS mobile_updated,
  CAST([Mobile_Loc] AS NVARCHAR(MAX)) AS mobile_loc,
  CONVERT(VARCHAR(30), [bct_r_date], 126) AS bct_r_date,
  CONVERT(VARCHAR(30), [bct_l_date], 126) AS bct_l_date,
  CAST(CAST([patient_cancer_age] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS patient_cancer_age,
  CAST(CAST([daughter_cancer_age] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS daughter_cancer_age,
  CAST([daughter_cancer_age_more] AS NVARCHAR(MAX)) AS daughter_cancer_age_more,
  CAST([sister_cancer_age_more] AS NVARCHAR(MAX)) AS sister_cancer_age_more,
  CAST([other_cancer_age_more] AS NVARCHAR(MAX)) AS other_cancer_age_more,
  CAST(CAST([stophormone_yrs] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS stophormone_yrs,
  CAST([CAhormone_use] AS NVARCHAR(MAX)) AS ca_hormone_use,
  CAST(CAST([CAhormone_yrs] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS ca_hormone_yrs,
  CAST(CAST([stopCAhormone_yrs] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS stop_ca_hormone_yrs,
  CAST(CAST([stopContr_yrs] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS stop_contr_yrs,
  CONVERT(VARCHAR(30), [rm_l_date], 126) AS rm_l_date,
  CONVERT(VARCHAR(30), [rm_r_date], 126) AS rm_r_date,
  CONVERT(VARCHAR(30), [ri_l_date], 126) AS ri_l_date,
  CONVERT(VARCHAR(30), [ri_r_date], 126) AS ri_r_date,
  CONVERT(VARCHAR(30), [fna_l_date], 126) AS fna_l_date,
  CONVERT(VARCHAR(30), [fna_r_date], 126) AS fna_r_date,
  CONVERT(VARCHAR(30), [fnx_l_date], 126) AS fnx_l_date,
  CONVERT(VARCHAR(30), [fnx_r_date], 126) AS fnx_r_date,
  CAST([sendExam_LoginName] AS NVARCHAR(MAX)) AS send_exam_login_name,
  CAST(CAST([Schedule_ID] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS schedule_id
FROM dbo.examination
ORDER BY [Exam_ID]
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
      if (env("TRUNCATE_EXAMINATION_FIRST", "") === "true") {
        console.error(">>> TRUNCATE public.examination (clone) ...");
        await client.query(truncateSql);
      }

      console.error(">>> สร้าง staging examination (01) ...");
      await client.query(ddl);

      console.error(
        ">>> ดึงจาก MSSQL แบบแบ่งหน้า แล้ว bulk insert staging ...",
      );
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

        const unnestArgs = arrays
          .map((_, idx) => `$${idx + 1}::text[]`)
          .join(", ");
        const colList = cols.join(", ");
        const insertStaging = `
INSERT INTO migrate_stg.examination_mssql (${colList})
SELECT * FROM unnest(${unnestArgs});
`;
        await client.query(insertStaging, arrays);

        total += n;
        console.error(`    ... ${total} แถว (staging)`);
        if (rows.length < batchSize) break;
        offset += batchSize;
      }

      let insertError = null;
      console.error(">>> แปลงเข้า public.examination (02) ...");
      try {
        await client.query(insertTarget);
      } catch (e) {
        insertError = e;
        console.error("!!! insert examination ไม่สำเร็จ");
        console.error(String(e?.message || e));
      }

      const stagingCountResult = await client.query(
        "SELECT COUNT(*)::bigint AS c FROM migrate_stg.examination_mssql;",
      );
      const targetCountResult = await client.query(
        "SELECT COUNT(*)::bigint AS c FROM public.examination;",
      );
      const matchedResult = await client.query(`
SELECT COUNT(DISTINCT migrate_stg.norm_exam_id(s.exam_id))::bigint AS c
FROM migrate_stg.examination_mssql s
JOIN public.examination e
  ON e.old_exam_id = (NULLIF(migrate_stg.norm_exam_id(s.exam_id), '')::bigint)::text
WHERE NULLIF(migrate_stg.norm_exam_id(s.exam_id), '') ~ '^[0-9]+$';
`);

      const missingResult = await client.query(`
SELECT s.exam_id,
  CASE
    WHEN NULLIF(migrate_stg.norm_exam_id(s.exam_id), '') !~ '^[0-9]+$' THEN 'invalid_exam_id'
    WHEN migrate_stg.norm_pid(s.pid) = '' THEN 'empty_pid'
    WHEN NOT EXISTS (
      SELECT 1 FROM public.patient_info p
      WHERE migrate_stg.norm_pid(p.pid::text) = migrate_stg.norm_pid(s.pid)
    ) THEN 'patient_not_found'
    ELSE 'unknown'
  END AS reason
FROM migrate_stg.examination_mssql s
LEFT JOIN public.examination e
  ON e.old_exam_id = (NULLIF(migrate_stg.norm_exam_id(s.exam_id), '')::bigint)::text
WHERE e.id IS NULL
ORDER BY s.exam_id;
`);

      const stagingCount = Number(stagingCountResult.rows?.[0]?.c ?? 0);
      const targetCount = Number(targetCountResult.rows?.[0]?.c ?? 0);
      const matchedCount = Number(matchedResult.rows?.[0]?.c ?? 0);
      const missingRows = missingResult.rows || [];
      const missingCount = missingRows.length;

      const summary = {
        generatedAt: new Date().toISOString(),
        sourceTable: "dbo.examination",
        targetTable: "public.examination",
        batchSize,
        totalReadFromMssql: total,
        stagingCount,
        targetCount,
        matchedCount,
        missingCount,
        completedFully: missingCount === 0 && !insertError,
        insertErrorMessage: insertError
          ? String(insertError?.message || insertError)
          : null,
      };
      const reportPaths = writeMigrationReport(reportDir, summary, missingRows);

      console.error(">>> สรุปผล migrate");
      console.error(`    - stagingCount: ${stagingCount}`);
      console.error(`    - matchedCount: ${matchedCount}`);
      console.error(`    - missingCount: ${missingCount}`);
      console.error(`    - completedFully: ${summary.completedFully}`);
      console.error(`    - summaryJson: ${reportPaths.jsonPath}`);
      console.error(`    - missingList: ${reportPaths.missingPath}`);

      if (insertError) {
        throw insertError;
      }

      console.error(
        `เสร็จแล้ว รวม ~${total} แถวจาก MSSQL (ตามจำนวนแถวที่อ่านได้ต่อรอบ)`,
      );
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
