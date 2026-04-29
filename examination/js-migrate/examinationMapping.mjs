/**
 * แมปแถว examination จาก MSSQL -> public.examination (เทียบ logic เดิมจาก SQL)
 */

const INT_RE = /^-?\d+$/;

function getField(row, key) {
  return row[key] ?? row[key.toLowerCase()] ?? row[key.toUpperCase()];
}

export function normExamId(v) {
  if (v == null) return "";
  return String(v)
    .replace(/^\uFEFF/, "")
    .trim();
}

export function normPid(v) {
  if (v == null) return "";
  return String(v)
    .replace(/^\uFEFF/, "")
    .trim();
}

function nullIfTrimEmpty(v) {
  if (v == null) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
}

function isDigitsOnly(v) {
  return INT_RE.test(v);
}

function toStrictInt(v) {
  const t = nullIfTrimEmpty(v);
  if (t == null || !isDigitsOnly(t)) return null;
  return Number.parseInt(t, 10);
}

function toBool01(v) {
  const t = nullIfTrimEmpty(v);
  if (t == null) return null;
  if (["1", "true", "True", "Y", "y", "t", "T"].includes(t)) return true;
  if (["0", "false", "False", "N", "n", "f", "F"].includes(t)) return false;
  return null;
}

/**
 * เทียบกับ mssql_be_datetime_to_timestamp:
 * - รับรูป "YYYY-MM-DD..." จาก MSSQL
 * - ถ้าปี >= 2200 ถือว่าเป็น พ.ศ. แล้วลบ 543
 * - คืนค่า "YYYY-MM-DD HH:mm:ss" หรือ null
 */
function toPgTimestamp(v) {
  const t = nullIfTrimEmpty(v);
  if (t == null || t.length < 10 || t[4] !== "-") return null;

  const y = Number.parseInt(t.slice(0, 4), 10);
  const m = t.slice(5, 7);
  const d = t.slice(8, 10);
  if (!Number.isFinite(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d))
    return null;

  const yyyy = y >= 2200 ? y - 543 : y;
  const timeRaw = t.slice(10).trim();
  if (timeRaw === "") return `${yyyy}-${m}-${d} 00:00:00`;

  const timePart = timeRaw.replace("T", " ").replace("Z", "");
  const hh = timePart.slice(0, 2);
  const mi = timePart.slice(3, 5);
  const ss = timePart.slice(6, 8);
  if (!/^\d{2}$/.test(hh) || !/^\d{2}$/.test(mi) || !/^\d{2}$/.test(ss)) {
    return `${yyyy}-${m}-${d} 00:00:00`;
  }
  return `${yyyy}-${m}-${d} ${hh}:${mi}:${ss}`;
}

function toUnixEpochSeconds(v) {
  const ts = toPgTimestamp(v);
  if (ts == null) return null;
  const ms = Date.parse(`${ts.replace(" ", "T")}Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

export function distinctOnNormExamId(mssqlRows) {
  const seen = new Map();
  for (const row of mssqlRows) {
    const nExamId = normExamId(getField(row, "exam_id"));
    if (nExamId === "") continue;
    if (!seen.has(nExamId)) seen.set(nExamId, row);
  }
  return Array.from(seen.values());
}

const INSERT_DEFS = [
  ["old_exam_id", "text", (row) => normExamId(getField(row, "exam_id"))],
  ["old_pid", "text", (row) => nullIfTrimEmpty(normPid(getField(row, "pid")))],
  ["patient", "int4", (_row, ctx) => ctx.patientId],
  [
    "exam_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "exam_date")),
  ],
  [
    "tech_login_name",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "tech_login_name")),
  ],
  ["mobile", "boolean", (row) => toBool01(getField(row, "mobile"))],
  [
    "mobile_update",
    "boolean",
    (row) => toBool01(getField(row, "mobile_update")),
  ],
  [
    "menstruation_age",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "menstruation_age")),
  ],
  [
    "menopause_age",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "menopause_age")),
  ],
  [
    "first_pregnancy_age",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "first_pregnancy_age")),
  ],
  [
    "num_pregnancy",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "num_pregnancy")),
  ],
  ["cont_use", "boolean", (row) => toBool01(getField(row, "cont_use"))],
  ["cont_yrs", "text", (row) => nullIfTrimEmpty(getField(row, "cont_yrs"))],
  ["hormone_use", "boolean", (row) => toBool01(getField(row, "hormone_use"))],
  [
    "hormone_yrs",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "hormone_yrs")),
  ],
  ["hysterectomy", "boolean", (row) => toBool01(getField(row, "hysterectomy"))],
  [
    "ovaries_removed",
    "boolean",
    (row) => toBool01(getField(row, "ovaries_removed")),
  ],
  ["pregnant", "boolean", (row) => toBool01(getField(row, "pragnant"))],
  ["referring_md", "int4", (row) => toStrictInt(getField(row, "referring_md"))],
  [
    "referring_hospital",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "referring_hospital")),
  ],
  [
    "prev_mammo_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "prev_mammo_date")),
  ],
  [
    "prev_mammo_loc",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "prev_mammo_loc")),
  ],
  [
    "sister_cancer_age",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "sister_cancer_age")),
  ],
  [
    "mother_cancer_age",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "mother_cancer_age")),
  ],
  [
    "grandmother_cancer_age",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "grandmother_cancer_age")),
  ],
  [
    "other_cancer_age",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "other_cancer_age")),
  ],
  [
    "biopsy_l_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "biopsy_l_date")),
  ],
  [
    "biopsy_r_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "biopsy_r_date")),
  ],
  [
    "chemo_l_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "chemo_l_date")),
  ],
  [
    "chemo_r_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "chemo_r_date")),
  ],
  [
    "cyst_l_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "cyst_l_date")),
  ],
  [
    "cyst_r_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "cyst_r_date")),
  ],
  [
    "irr_l_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "irr_l_date")),
  ],
  [
    "irr_r_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "irr_r_date")),
  ],
  [
    "lump_l_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "lump_l_date")),
  ],
  [
    "lump_r_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "lump_r_date")),
  ],
  [
    "mast_l_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "mast_l_date")),
  ],
  [
    "mast_r_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "mast_r_date")),
  ],
  [
    "rad_l_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "rad_l_date")),
  ],
  [
    "rad_r_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "rad_r_date")),
  ],
  [
    "num_left_mass",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "num_left_mass")),
  ],
  [
    "num_right_mass",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "num_right_mass")),
  ],
  ["lnwn", "boolean", (row) => toBool01(getField(row, "lnwn"))],
  ["lnww", "boolean", (row) => toBool01(getField(row, "lnww"))],
  ["ln", "boolean", (row) => toBool01(getField(row, "ln"))],
  ["lnen", "boolean", (row) => toBool01(getField(row, "lnen"))],
  ["lnee", "boolean", (row) => toBool01(getField(row, "lnee"))],
  ["le", "boolean", (row) => toBool01(getField(row, "le"))],
  ["lm", "boolean", (row) => toBool01(getField(row, "lm"))],
  ["lw", "boolean", (row) => toBool01(getField(row, "lw"))],
  ["lsws", "boolean", (row) => toBool01(getField(row, "lsws"))],
  ["lsww", "boolean", (row) => toBool01(getField(row, "lsww"))],
  ["ls", "boolean", (row) => toBool01(getField(row, "ls"))],
  ["lses", "boolean", (row) => toBool01(getField(row, "lses"))],
  ["lsee", "boolean", (row) => toBool01(getField(row, "lsee"))],
  ["rnwn", "boolean", (row) => toBool01(getField(row, "rnwn"))],
  ["rnww", "boolean", (row) => toBool01(getField(row, "rnww"))],
  ["rn", "boolean", (row) => toBool01(getField(row, "rn"))],
  ["rnen", "boolean", (row) => toBool01(getField(row, "rnen"))],
  ["rnee", "boolean", (row) => toBool01(getField(row, "rnee"))],
  ["re", "boolean", (row) => toBool01(getField(row, "re"))],
  ["rm", "boolean", (row) => toBool01(getField(row, "rm"))],
  ["rw", "boolean", (row) => toBool01(getField(row, "rw"))],
  ["rsws", "boolean", (row) => toBool01(getField(row, "rsws"))],
  ["rsww", "boolean", (row) => toBool01(getField(row, "rsww"))],
  ["rs", "boolean", (row) => toBool01(getField(row, "rs"))],
  ["rses", "boolean", (row) => toBool01(getField(row, "rses"))],
  ["rsee", "boolean", (row) => toBool01(getField(row, "rsee"))],
  ["lother", "boolean", (row) => toBool01(getField(row, "lother"))],
  ["rother", "boolean", (row) => toBool01(getField(row, "rother"))],
  ["l_axillar", "boolean", (row) => toBool01(getField(row, "l_axillar"))],
  ["r_axillar", "boolean", (row) => toBool01(getField(row, "r_axillar"))],
  ["exam_reason", "int4", (row) => toStrictInt(getField(row, "exam_reason"))],
  [
    "exam_reason_text",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "exam_reason_text")),
  ],
  [
    "exam_reason_memotext",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "exam_reason_memotext")),
  ],
  [
    "pain_l_duration",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "pain_l_duration")),
  ],
  [
    "pain_r_duration",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "pain_r_duration")),
  ],
  [
    "mobile_updated",
    "int4",
    (row) => toUnixEpochSeconds(getField(row, "mobile_updated")),
  ],
  ["mobile_loc", "int4", (row) => toStrictInt(getField(row, "mobile_loc"))],
  [
    "bct_l_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "bct_l_date")),
  ],
  [
    "bct_r_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "bct_r_date")),
  ],
  [
    "patient_cancer_age",
    "int4",
    (row) => toStrictInt(getField(row, "patient_cancer_age")),
  ],
  [
    "daughter_cancer_age",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "daughter_cancer_age")),
  ],
  [
    "daughter_cancer_age_more",
    "boolean",
    (row) => toBool01(getField(row, "daughter_cancer_age_more")),
  ],
  [
    "sister_cancer_age_more",
    "boolean",
    (row) => toBool01(getField(row, "sister_cancer_age_more")),
  ],
  [
    "other_cancer_age_more",
    "boolean",
    (row) => toBool01(getField(row, "other_cancer_age_more")),
  ],
  [
    "stophormone_yrs",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "stophormone_yrs")),
  ],
  [
    "ca_hormone_use",
    "boolean",
    (row) => toBool01(getField(row, "ca_hormone_use")),
  ],
  [
    "ca_hormone_yrs",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "ca_hormone_yrs")),
  ],
  [
    "stop_ca_hormone_yrs",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "stop_ca_hormone_yrs")),
  ],
  [
    "stop_contr_yrs",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "stop_contr_yrs")),
  ],
  [
    "rm_l_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "rm_l_date")),
  ],
  [
    "rm_r_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "rm_r_date")),
  ],
  [
    "ri_l_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "ri_l_date")),
  ],
  [
    "ri_r_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "ri_r_date")),
  ],
  [
    "fna_l_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "fna_l_date")),
  ],
  [
    "fna_r_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "fna_r_date")),
  ],
  [
    "fnx_l_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "fnx_l_date")),
  ],
  [
    "fnx_r_date",
    "timestamp",
    (row) => toPgTimestamp(getField(row, "fnx_r_date")),
  ],
  [
    "send_exam_login_name",
    "text",
    (row) => nullIfTrimEmpty(getField(row, "send_exam_login_name")),
  ],
  ["appointment", "int4", (_row, ctx) => ctx.appointmentId],
];

function assertStagingFromClause(stagingFromClause) {
  const t = String(stagingFromClause ?? "").trim();
  if (!/^\w+\.\w+$/.test(t)) {
    throw new Error(
      `examination post-load: staging ต้องเป็น schema.table (a-z, 0-9, _): ได้ "${stagingFromClause}"`,
    );
  }
  return t;
}

async function resolveSingleColumnFk(pgClient, { schema, table, column }) {
  const r = await pgClient.query(
    `
    SELECT
      child_ns.nspname AS child_schema,
      child_rel.relname AS child_table,
      child_att.attname AS child_column,
      parent_ns.nspname AS parent_schema,
      parent_rel.relname AS parent_table,
      parent_att.attname AS parent_column
    FROM pg_constraint con
    JOIN pg_class child_rel ON child_rel.oid = con.conrelid
    JOIN pg_namespace child_ns ON child_ns.oid = child_rel.relnamespace
    JOIN pg_attribute child_att
      ON child_att.attrelid = con.conrelid
     AND child_att.attnum = con.conkey[1]
    JOIN pg_class parent_rel ON parent_rel.oid = con.confrelid
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent_rel.relnamespace
    JOIN pg_attribute parent_att
      ON parent_att.attrelid = con.confrelid
     AND parent_att.attnum = con.confkey[1]
    WHERE con.contype = 'f'
      AND array_length(con.conkey, 1) = 1
      AND child_ns.nspname = $1
      AND child_rel.relname = $2
      AND child_att.attname = $3
    LIMIT 1
    `,
    [schema, table, column],
  );
  return r.rows[0] ?? null;
}

let cachedPublicExaminationPatientCol = null;

/**
 * Django/Postgres มักใช้ patient_id; โมเดลเก่าใช้ patient — สอบถาม information_schema
 */
export async function resolvePublicExaminationPatientColumn(pgClient) {
  if (cachedPublicExaminationPatientCol)
    return cachedPublicExaminationPatientCol;
  const r = await pgClient.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'examination'
       AND column_name IN ('patient_id', 'patient')
     ORDER BY CASE column_name
       WHEN 'patient_id' THEN 0
       WHEN 'patient' THEN 1
     END
     LIMIT 1`,
  );
  if (r.rows.length === 0) {
    cachedPublicExaminationPatientCol = "patient";
  } else {
    cachedPublicExaminationPatientCol = r.rows[0].column_name;
  }
  return cachedPublicExaminationPatientCol;
}

/**
 * จับ patient จากข้อมูลบน staging ที่ load ลง PG จริง (ตรงกับ unnest) แทน in-memory จาก mssql
 * เพื่อไม่เสีย key เวลา pid รูปแบบ/ชนิดต่างจาก getField+String
 */
export async function runExaminationChunkPostLoad(
  pgClient,
  mssqlRows,
  stagingFromClause = "migrate_stg.examination_mssql",
  options = {},
) {
  const verbose = options.verbose === true;
  const log = (msg) => {
    if (verbose) console.error(msg);
  };
  const stg = assertStagingFromClause(stagingFromClause);
  const rows = distinctOnNormExamId(mssqlRows);
  if (rows.length === 0) return;

  const examIds = rows
    .map((r) => normExamId(getField(r, "exam_id")))
    .filter((id) => id !== "" && isDigitsOnly(id));

  if (examIds.length === 0) return;

  const mssqlExamU = rows.map((r) => String(getField(r, "exam_id") ?? ""));
  const { rows: stgCountRow } = await pgClient.query(
    `SELECT count(*)::int AS c FROM ${stg} s`,
  );
  const stgC = stgCountRow[0]?.c ?? 0;

  /**
   * unnest(ค่า exam จาก mssql) JOIN staging ด้วย norm_exam_id — รองรับกรณี String(mssql) กับ s.exam_id
   * (หลัง toStr ใน migrate) ไม่เหมือนกันทีละอักขระ
   */
  const bridgeRes = await pgClient.query(
    `SELECT DISTINCT ON (m.u)
       m.u::text AS u,
       p.id AS patient_id
     FROM unnest($1::text[]) AS m(u)
     INNER JOIN ${stg} s
       ON NULLIF(migrate_stg.norm_exam_id(m.u::text), '')::text
          = NULLIF(migrate_stg.norm_exam_id(s.exam_id::text), '')::text
     LEFT JOIN public.patient_info p
       ON migrate_stg.norm_pid(p.pid::text) = migrate_stg.norm_pid(s.pid)
     WHERE NULLIF(migrate_stg.norm_exam_id(m.u::text), '')::text ~ '^[0-9]+$'
     ORDER BY m.u, s.exam_id`,
    [mssqlExamU],
  );
  const mssqlUToPatient = new Map(
    bridgeRes.rows.map((r) => [r.u, r.patient_id]),
  );
  const withPatient = bridgeRes.rows.filter((r) => r.patient_id != null).length;
  const withoutPatient = mssqlUToPatient.size - withPatient;
  if (mssqlUToPatient.size === 0 && stgC > 0) {
    log(
      `>>> [examination] post-load: มี staging ${stgC} แต่ bridge mssql↔stg ไม่ได้ mapping (ตรวจ exam_id ตรง staging หรือยัง)`,
    );
  } else {
    log(
      `>>> [examination] post-load: staging ${stgC} แถว, bridge ได้ ${mssqlUToPatient.size} ราย (patient_info ตรง ${withPatient} ราย, ไม่ตรง/ว่าง ${withoutPatient} ราย — ยัง insert examination โดย patient=null ได้)`,
    );
  }

  const patientCol = await resolvePublicExaminationPatientColumn(pgClient);
  if (patientCol !== "patient") {
    log(
      `>>> [examination] post-load: ตาราง public.examination ใช้คอลัมน์ \`${patientCol}\` แทน \`patient\` — insert อัปเดตให้ตรงฐาน`,
    );
  }

  const scheduleIds = Array.from(
    new Set(
      rows
        .map((r) => toStrictInt(getField(r, "schedule_id")))
        .filter((id) => Number.isInteger(id)),
    ),
  );

  const appointmentRows =
    scheduleIds.length > 0
      ? await pgClient.query(
          "SELECT id FROM public.appointment WHERE id = ANY($1::int[])",
          [scheduleIds],
        )
      : { rows: [] };
  const appointmentSet = new Set(appointmentRows.rows.map((r) => r.id));

  await pgClient.query(
    "DELETE FROM public.examination WHERE old_exam_id = ANY($1::text[])",
    [examIds],
  );
  await pgClient.query(`
    SELECT setval(
      pg_get_serial_sequence('public.examination', 'id'),
      COALESCE((SELECT MAX(id) + 1 FROM public.examination), 1),
      false
    );
  `);

  const referringIdx = INSERT_DEFS.findIndex(
    ([name]) => name === "referring_md",
  );
  let validReferringSet = null;
  if (referringIdx >= 0) {
    const fk = await resolveSingleColumnFk(pgClient, {
      schema: "public",
      table: "examination",
      column: "referring_md",
    });
    if (fk?.parent_schema && fk?.parent_table && fk?.parent_column) {
      const candidateReferring = Array.from(
        new Set(
          rows
            .map((r) => toStrictInt(getField(r, "referring_md")))
            .filter((v) => Number.isInteger(v)),
        ),
      );
      if (candidateReferring.length > 0) {
        const q = `SELECT ${fk.parent_column} AS id FROM ${fk.parent_schema}.${fk.parent_table} WHERE ${fk.parent_column} = ANY($1::int[])`;
        const { rows: refRows } = await pgClient.query(q, [candidateReferring]);
        validReferringSet = new Set(refRows.map((r) => r.id));
        console.error(
          `>>> [examination] post-load: FK referring_md → ${fk.parent_schema}.${fk.parent_table}(${fk.parent_column}); candidate=${candidateReferring.length} valid=${validReferringSet.size}`,
        );
      }
    }
  }

  const arrays = INSERT_DEFS.map(() => []);
  let referringNullified = 0;
  for (const row of rows) {
    const examId = normExamId(getField(row, "exam_id"));
    if (examId === "" || !isDigitsOnly(examId)) continue;

    const u = String(getField(row, "exam_id") ?? "");
    const patientId = mssqlUToPatient.get(u) ?? null;

    const scheduleId = toStrictInt(getField(row, "schedule_id"));
    const appointmentId =
      scheduleId != null && appointmentSet.has(scheduleId) ? scheduleId : null;
    const context = { patientId, appointmentId };

    for (let i = 0; i < INSERT_DEFS.length; i++) {
      let v = INSERT_DEFS[i][2](row, context);
      if (
        i === referringIdx &&
        validReferringSet &&
        v != null &&
        !validReferringSet.has(v)
      ) {
        v = null;
        referringNullified += 1;
      }
      arrays[i].push(v);
    }
  }

  if (arrays[0].length === 0) {
    log(
      `>>> [examination] post-load: จะ insert 0 แถว (map patient ${mssqlUToPatient.size} ราย; กรอง exam/schedule)`,
    );
    return;
  }

  if (referringNullified > 0) {
    console.error(
      `>>> [examination] post-load: referring_md ถูกตัดเป็น null ${referringNullified} ค่า (กัน FK examination_referring_md_foreign ล้ม; ควรกลับมา seed/แก้ master ทีหลัง)`,
    );
  }

  const colList = INSERT_DEFS.map(([name], idx) =>
    idx === 2 ? patientCol : name,
  ).join(", ");
  const unnestArgs = INSERT_DEFS.map(
    ([, type], idx) => `$${idx + 1}::${type}[]`,
  ).join(", ");

  const ins = await pgClient.query(
    `
    INSERT INTO public.examination (${colList})
    SELECT * FROM unnest(${unnestArgs});
    `,
    arrays,
  );
  log(
    `>>> [examination] post-load: insert public.examination แล้ว ${ins.rowCount ?? arrays[0].length} แถว (คอลัมน์ patient → ${patientCol})`,
  );
}
