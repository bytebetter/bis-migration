/**
 * nurse_work ของนัด BX ที่ย้ายจาก DB เก่า
 *
 * ระบบใหม่ flow [id-78] สร้าง nurse_work คู่กับนัด request = "bx" (ผูก nurse_work.appointment)
 * แล้ว flow [id-87] สร้าง exam ให้และผูก 2 ทาง (nurse_work.examination + examination.nurse_work)
 * นัดที่ migrate ลงตรงด้วย SQL ไม่ผ่าน flow → หน้าที่อ่านงาน BX ผ่าน nurse_work ไม่เห็นนัดเก่า
 *
 * user สั่ง 2026-11-23:
 * - นัดที่ request = "bx" หรือ inventional = 1 → สร้าง nurse_work ผูก relation ให้ครบ
 * - nurse_work.status = "2" (เสร็จสิ้น), nurse_work.bx_status = "0" (สร้างนัดหมาย BX สำเร็จ)
 *   ตาม choices ใน directus_fields — appointment.appointment_status ไม่แตะ
 * - nurse_work.appointed_dept = "nurse" + appointment.department_bx = "nurse" (fix ไปก่อน — DB เก่าไม่มีแผนก)
 *   department_bx เติมเฉพาะที่ว่าง ตอนสร้าง nurse_work ของนัดนั้น
 *   ไม่ทำให้ขึ้นคิวงาน "สร้างนัดหมาย" ของพยาบาล เพราะ date_created ว่าง + status เสร็จสิ้น
 *
 * กติกา:
 * - เฉพาะนัดที่ migrate มา (old_db_id ไม่ว่าง) — นัดระบบใหม่ flow สร้าง nurse_work ให้อยู่แล้ว
 * - นัดละ 1 แถว มี nurse_work อยู่แล้วข้าม (กันซ้ำแบบเดียวกับ flow [id-78]) → ค่าที่แก้ในระบบใหม่ไม่ถูกทับ
 * - appointment_datetime = เวลานัด (หน้าพยาบาลกรองวันจาก nurse_work เอง; ระบบใหม่ flow [id-82] sync ให้)
 *   รอบต่อไป sync ตามนัดเมื่อ migrate เปลี่ยนเวลานัด (UPDATE ตรงไม่ผ่าน flow [id-82])
 * - exam: exam ที่ migrate มาของนัดนั้น (examination.appointment = นัด, old_exam_id ไม่ว่าง) ตัวล่าสุด
 *   ผูก 2 ทางเฉพาะช่องที่ยังว่าง; exam ที่ผูก nurse_work อื่นอยู่แล้วไม่ใช้
 *   examination migrate หลัง appointment (step 4) → เรียกท้ายทั้ง job appointment และ examination
 *
 * user สั่ง 2026-11-25: nurse_work ที่ยังไม่มี exam ผูก (DB เก่าไม่มี exam ของนัดนั้น) → สร้าง exam ให้ทุกตัว
 * รวมนัดในอดีต — แบบ flow [id-87] (flow ไม่ทำงานเพราะ nurse_work ลง SQL ตรง ไม่มี event)
 * - exam ใหม่: nurse_work, appointment, patient (คนไข้ของนัด), exam_date = เวลานัด
 *   + คัดลอกฟิลด์ประวัติจาก exam ก่อนหน้าของคนไข้ (FLOW_ID87_COPY_FIELDS) + exam_reason_type "Special Procedure"
 *   ต่างจาก flow ตรงที่ "exam ก่อนหน้า" = exam_date ไม่เกินเวลานัด (flow ใช้ตัวล่าสุด ณ วันสร้าง —
 *   นัดในอดีตจะได้ประวัติจากอนาคต); status ไม่ตั้ง (flow ก็ไม่ตั้ง)
 * - สร้างตอนท้าย job examination เท่านั้น (exam จริงของนัดเข้ามาก่อน ผูกตัวจริงก่อนแล้วค่อยสร้างที่ขาด)
 *   และเฉพาะ nurse_work ที่ migrate สร้าง (date_created ว่าง) — nurse_work ของ flow มี exam จาก [id-87] แล้ว
 * - exam ที่สร้างแยกจาก exam จริงด้วย old_exam_id ว่าง + date_created ว่าง + user_created ว่าง
 *   (exam ที่ migrate มามี old_exam_id; exam ที่สร้างผ่าน Directus มี date_created)
 * - รอบต่อไป DB เก่ามี exam ของนัดนั้นเข้ามา (เช่น นัดอนาคตไปทำที่ระบบเก่าก่อน cutover)
 *   → ลบ exam ที่สร้างไว้แล้วผูก exam จริงแทน เฉพาะ exam ที่ยังไม่ถูกแตะในระบบใหม่
 *   (date_updated / user_updated ว่าง และไม่มีตารางอื่นอ้างถึง) — ถูกแตะแล้วคงไว้ exam จริงไม่ผูก
 * - patient / exam_date ของ exam ที่สร้าง sync ตามนัดทุกรอบ (นัดย้ายจากคนไข้ K → คนจริง ให้ลบ K ได้)
 *   → เรียกก่อนลบ K ทั้ง 2 job
 */

/** ฟิลด์ที่ flow [id-87] (create_exam_payload) คัดลอกจาก exam ก่อนหน้า — เรียงตาม flow */
export const FLOW_ID87_COPY_FIELDS = [
  "menstruation_age", "menopause_age", "first_pregnancy_age", "num_pregnancy",
  "hormone_use", "hormone_yrs",
  "cont_use", "cont_yrs",
  "ca_hormone_use", "ca_hormone_yrs",
  "hysterectomy", "ovaries_removed",
  "mother_cancer", "mother_cancer_age",
  "daughter_cancer", "daughter_cancer_age_more", "daughter_cancer_age",
  "sister_cancer", "sister_cancer_age_more", "sister_cancer_age",
  "grandmother_cancer", "grandmother_cancer_age",
  "other_cancer", "other_cancer_age_more", "other_cancer_age",
  "exam_reason_memotext", "limitation",
  "l_side_mass", "num_left_mass",
  "r_side_mass", "num_right_mass",
  "ln", "lnwn", "lnen", "lnww", "lnee", "lw", "lm", "le", "lsww", "lsee", "lsws", "lses", "ls", "l_axillar", "lother",
  "rn", "rnwn", "rnen", "rnww", "rnee", "rw", "rm", "re", "rsww", "rsee", "rsws", "rses", "rs", "r_axillar", "rother",
];
/** flow [id-87] ตั้งเมื่อมี exam ก่อนหน้า */
export const FLOW_ID87_EXAM_REASON_TYPE = "Special Procedure";

export const MIGRATED_BX_NURSE_WORK_STATUS = "2";
export const MIGRATED_BX_NURSE_WORK_BX_STATUS = "0";
/** nurse_work.appointed_dept + appointment.department_bx — DB เก่าไม่มีแผนก user สั่งให้เป็น nurse ไปก่อน */
export const MIGRATED_BX_DEPARTMENT = "nurse";
const APPOINTMENT_REQUEST_BX = "bx";
const THAI_TIME_ZONE = "Asia/Bangkok";

async function tableColumns(pgClient, tableName) {
  const r = await pgClient.query(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName],
  );
  return new Map(r.rows.map((x) => [x.column_name, x.data_type]));
}

/**
 * appointment.appointment_datetime (เวลาไทยบนนาฬิกา) → ชนิดของ nurse_work.appointment_datetime
 * ชนิดเดียวกันคัดลอกตรง; timestamp → timestamptz ตีความเป็นเวลาไทย ไม่พึ่ง TimeZone ของ session
 */
function appointmentDatetimeExpr(srcExpr, srcType, dstType) {
  if (
    srcType === "timestamp without time zone" &&
    dstType === "timestamp with time zone"
  ) {
    return `(${srcExpr} AT TIME ZONE '${THAI_TIME_ZONE}')`;
  }
  return srcExpr;
}

function firstExisting(cols, names) {
  return names.find((n) => cols.has(n)) ?? null;
}

/** คอลัมน์ (ตาราง, คอลัมน์) ที่มี FK ชี้ examination.id — ใช้เช็คว่า exam ที่สร้างถูกงานอื่นอ้างถึงหรือยัง */
async function examinationReferences(pgClient) {
  const r = await pgClient.query(`
    SELECT cl.relname AS table_name, att.attname AS column_name
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = c.conkey[1]
    WHERE c.contype = 'f'
      AND c.confrelid = 'public.examination'::regclass
      AND array_length(c.conkey, 1) = 1
      AND ns.nspname = 'public'
  `);
  return r.rows.map((x) => ({ table: x.table_name, column: x.column_name }));
}

const quoteIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;

/**
 * @returns {Promise<{
 *   created: number,
 *   departmentBxFilled: number,
 *   datetimeSynced: number,
 *   nurseWorkExamLinked: number,
 *   examNurseWorkLinked: number,
 *   examCreated: number,
 *   examReplaced: number,
 *   examSynced: number,
 * } | null>} null = ปลายทางยังไม่มีตาราง/คอลัมน์ที่ต้องใช้ (ข้าม)
 * @param {{ linkExamOnly?: boolean, createMissingExam?: boolean }} [options]
 *   linkExamOnly = ผูก exam อย่างเดียว (job examination ไม่ได้เพิ่มนัด/เปลี่ยนเวลานัด —
 *   ข้าม 2 query ที่สแกน appointment ทั้งตาราง)
 *   createMissingExam = สร้าง exam ให้ nurse_work ที่ผูก exam จริงไม่ได้ (job examination เท่านั้น)
 */
export async function syncMigratedBxNurseWork(pgClient, options = {}) {
  const linkExamOnly = options.linkExamOnly === true;
  const createMissingExam = options.createMissingExam === true;
  const aptCols = await tableColumns(pgClient, "appointment");
  const nwCols = await tableColumns(pgClient, "nurse_work");
  if (
    !aptCols.has("old_db_id") ||
    !nwCols.has("appointment") ||
    !nwCols.has("status") ||
    !nwCols.has("bx_status")
  ) {
    return null;
  }

  const bxConds = [];
  if (aptCols.has("inventional")) bxConds.push("a.inventional = 1");
  if (aptCols.has("request")) {
    bxConds.push(`lower(btrim(a.request::text)) = '${APPOINTMENT_REQUEST_BX}'`);
  }
  if (bxConds.length === 0) return null;
  const bxAppointmentWhere = `a.old_db_id IS NOT NULL AND (${bxConds.join(" OR ")})`;

  const hasDatetime =
    aptCols.has("appointment_datetime") && nwCols.has("appointment_datetime");
  const datetimeExpr = hasDatetime
    ? appointmentDatetimeExpr(
        "a.appointment_datetime",
        aptCols.get("appointment_datetime"),
        nwCols.get("appointment_datetime"),
      )
    : null;

  const insertCols = ["appointment", "status", "bx_status"];
  const selectExprs = ["t.id", "$1::text", "$2::text"];
  if (hasDatetime) {
    insertCols.push("appointment_datetime");
    selectExprs.push("t.dt");
  }
  if (nwCols.has("appointed_dept")) {
    insertCols.push("appointed_dept");
    selectExprs.push("$3::text");
  }
  // department_bx ตั้งพร้อมสร้าง nurse_work (นัดที่สร้างรอบนี้เท่านั้น ไม่สแกนตารางเพิ่ม) ไม่ทับค่าที่มีอยู่
  const hasDepartmentBx = aptCols.has("department_bx");

  const created = linkExamOnly
    ? null
    : await pgClient.query(
    `
    WITH tgt AS (
      SELECT a.id${hasDatetime ? `, ${datetimeExpr} AS dt` : ""}
      FROM public.appointment a
      WHERE ${bxAppointmentWhere}
        AND NOT EXISTS (
          SELECT 1 FROM public.nurse_work nw WHERE nw.appointment = a.id
        )
    ),
    ins AS (
      INSERT INTO public.nurse_work (${insertCols.join(", ")})
      SELECT ${selectExprs.join(", ")}
      FROM tgt t
      ORDER BY t.id
      RETURNING appointment
    )${
      hasDepartmentBx
        ? `,
    dept AS (
      UPDATE public.appointment AS a
      SET department_bx = $3::text
      FROM ins
      WHERE a.id = ins.appointment
        AND a.department_bx IS NULL
      RETURNING 1
    )`
        : ""
    }
    SELECT
      (SELECT count(*)::int FROM ins) AS n,
      ${hasDepartmentBx ? "(SELECT count(*)::int FROM dept)" : "0"} AS dept_filled
    `,
    [
      MIGRATED_BX_NURSE_WORK_STATUS,
      MIGRATED_BX_NURSE_WORK_BX_STATUS,
      // ส่งเกินจำนวนที่ SQL ใช้ Postgres ไม่รับ — ใส่ $3 เฉพาะเมื่อมีคอลัมน์แผนกสักฝั่ง
      ...(nwCols.has("appointed_dept") || hasDepartmentBx
        ? [MIGRATED_BX_DEPARTMENT]
        : []),
    ],
  );

  let datetimeSynced = 0;
  if (hasDatetime && !linkExamOnly) {
    const upd = await pgClient.query(`
      UPDATE public.nurse_work AS nw
      SET appointment_datetime = ${datetimeExpr}
      FROM public.appointment a
      WHERE nw.appointment = a.id
        AND ${bxAppointmentWhere}
        AND nw.appointment_datetime IS DISTINCT FROM ${datetimeExpr}
    `);
    datetimeSynced = upd.rowCount ?? 0;
  }

  let nurseWorkExamLinked = 0;
  let examNurseWorkLinked = 0;
  let examCreated = 0;
  let examReplaced = 0;
  let examSynced = 0;
  const examCols = await tableColumns(pgClient, "examination");
  if (
    nwCols.has("examination") &&
    examCols.has("appointment") &&
    examCols.has("nurse_work") &&
    examCols.has("old_exam_id")
  ) {
    const ph = placeholderExamContext({ aptCols, nwCols, examCols, bxAppointmentWhere });
    if (ph != null) {
      // ก่อนผูก: exam จริงเข้ามาแล้ว → เอา exam ที่สร้างไว้ออก ให้ query ผูกด้านล่างผูกตัวจริง
      examReplaced = await replacePlaceholderExams(pgClient, ph);
      examSynced = await syncPlaceholderExams(pgClient, ph);
    }
    const examOrder = examCols.has("exam_date")
      ? "e.exam_date DESC NULLS LAST, e.id DESC"
      : "e.id DESC";
    // นัดเดียวมีหลาย nurse_work (เช่น flow ระบบใหม่สร้างเพิ่ม) → exam หนึ่งตัวผูกได้ nurse_work เดียว (id น้อยสุด)
    const linked = await pgClient.query(`
      WITH latest AS (
        SELECT DISTINCT ON (nw.id) nw.id AS nurse_work_id, e.id AS exam_id
        FROM public.nurse_work nw
        INNER JOIN public.appointment a ON a.id = nw.appointment
        INNER JOIN public.examination e ON e.appointment = a.id
        WHERE nw.examination IS NULL
          AND ${bxAppointmentWhere}
          AND e.old_exam_id IS NOT NULL
          AND (e.nurse_work IS NULL OR e.nurse_work = nw.id)
        ORDER BY nw.id, ${examOrder}
      ),
      pick AS (
        SELECT DISTINCT ON (exam_id) nurse_work_id, exam_id
        FROM latest
        ORDER BY exam_id, nurse_work_id
      ),
      upd_nw AS (
        UPDATE public.nurse_work AS nw
        SET examination = p.exam_id
        FROM pick p
        WHERE nw.id = p.nurse_work_id
        RETURNING nw.id
      ),
      upd_exam AS (
        UPDATE public.examination AS e
        SET nurse_work = p.nurse_work_id
        FROM pick p
        WHERE e.id = p.exam_id
          AND e.nurse_work IS NULL
        RETURNING e.id
      )
      SELECT
        (SELECT count(*)::int FROM upd_nw) AS nw_linked,
        (SELECT count(*)::int FROM upd_exam) AS exam_linked
    `);
    nurseWorkExamLinked = Number(linked.rows[0]?.nw_linked ?? 0);
    examNurseWorkLinked = Number(linked.rows[0]?.exam_linked ?? 0);

    // หลังผูก: nurse_work ที่ยังไม่มี exam (DB เก่าไม่มี exam ของนัด) → สร้างแบบ flow [id-87]
    if (ph != null && createMissingExam) {
      examCreated = await createPlaceholderExams(pgClient, ph);
    }
  }

  return {
    created: Number(created?.rows[0]?.n ?? 0),
    departmentBxFilled: Number(created?.rows[0]?.dept_filled ?? 0),
    datetimeSynced,
    nurseWorkExamLinked,
    examNurseWorkLinked,
    examCreated,
    examReplaced,
    examSynced,
  };
}

/**
 * ของที่ใช้ร่วมกันของ exam ที่ migrate สร้างให้ nurse_work — null = ปลายทางไม่มีคอลัมน์ที่ต้องใช้ (ข้าม)
 * ต้องมี date_created (ใช้แยก exam ที่สร้างออกจาก exam ของระบบใหม่) และคอลัมน์คนไข้ทั้ง 2 ตาราง
 */
function placeholderExamContext({ aptCols, nwCols, examCols, bxAppointmentWhere }) {
  const examPatientCol = firstExisting(examCols, ["patient_id", "patient"]);
  const aptPatientCol = firstExisting(aptCols, ["patient_info", "patient_id", "patient"]);
  if (!examCols.has("date_created") || examPatientCol == null || aptPatientCol == null) {
    return null;
  }
  const hasExamDate = examCols.has("exam_date") && aptCols.has("appointment_datetime");
  const examDateExpr = hasExamDate
    ? appointmentDatetimeExpr(
        "a.appointment_datetime",
        aptCols.get("appointment_datetime"),
        examCols.get("exam_date"),
      )
    : null;
  /** exam ที่ migrate สร้าง (alias ของ exam) — ไม่มี old_exam_id และไม่ได้สร้างผ่าน Directus */
  const isPlaceholder = (e) =>
    `${e}.old_exam_id IS NULL AND ${e}.date_created IS NULL` +
    (examCols.has("user_created") ? ` AND ${e}.user_created IS NULL` : "") +
    ` AND ${e}.nurse_work IS NOT NULL`;
  return {
    bxAppointmentWhere,
    examCols,
    examPatientCol,
    aptPatientCol,
    hasExamDate,
    examDateExpr,
    isPlaceholder,
    /** nurse_work ที่ migrate สร้าง (nurse_work ของ flow มี date_created และได้ exam จาก [id-87] แล้ว) */
    nwMigratedWhere: nwCols.has("date_created") ? "nw.date_created IS NULL" : "TRUE",
    untouchedWhere: [
      examCols.has("date_updated") ? "e.date_updated IS NULL" : null,
      examCols.has("user_updated") ? "e.user_updated IS NULL" : null,
    ]
      .filter(Boolean)
      .join(" AND ") || "TRUE",
  };
}

/**
 * exam ที่สร้างไว้ แต่ตอนนี้นัดมี exam จริงจาก DB เก่าที่ผูกได้ → ลบ exam ที่สร้าง + ปลด nurse_work.examination
 * เฉพาะตัวที่ยังไม่ถูกแตะ: date_updated/user_updated ว่าง และไม่มีตารางอื่นอ้างถึง
 * (FK ทุกตัวเป็น ON DELETE SET NULL — ลบตัวที่ถูกอ้างจะทำให้งานในระบบใหม่หลุด exam แบบเงียบ)
 * @returns {Promise<number>} จำนวน exam ที่ลบ
 */
async function replacePlaceholderExams(pgClient, ph) {
  const cand = await pgClient.query(`
    SELECT e.id
    FROM public.nurse_work nw
    INNER JOIN public.appointment a ON a.id = nw.appointment
    INNER JOIN public.examination e ON e.id = nw.examination AND e.nurse_work = nw.id
    WHERE ${ph.bxAppointmentWhere}
      AND ${ph.isPlaceholder("e")}
      AND ${ph.untouchedWhere}
      AND EXISTS (
        SELECT 1 FROM public.examination r
        WHERE r.appointment = a.id
          AND r.old_exam_id IS NOT NULL
          AND (r.nurse_work IS NULL OR r.nurse_work = nw.id)
      )
  `);
  let ids = cand.rows.map((r) => Number(r.id));
  if (ids.length === 0) return 0;

  // แถวที่ตารางอื่นชี้มา (nurse_work.examination ของตัวเองไม่นับ — นับเมื่อมี nurse_work อื่นชี้ด้วย)
  const refs = await examinationReferences(pgClient);
  const used = refs.map((r) =>
    r.table === "nurse_work" && r.column === "examination"
      ? `SELECT x.examination::int AS id FROM public.nurse_work x
         WHERE x.examination = ANY($1::int[]) GROUP BY x.examination HAVING count(*) > 1`
      : `SELECT x.${quoteIdent(r.column)}::int AS id FROM public.${quoteIdent(r.table)} x
         WHERE x.${quoteIdent(r.column)} = ANY($1::int[])`,
  );
  if (used.length > 0) {
    const usedRows = await pgClient.query(used.join(" UNION "), [ids]);
    const usedIds = new Set(usedRows.rows.map((r) => Number(r.id)));
    ids = ids.filter((id) => !usedIds.has(id));
  }
  if (ids.length === 0) return 0;

  await pgClient.query(
    `UPDATE public.nurse_work SET examination = NULL WHERE examination = ANY($1::int[])`,
    [ids],
  );
  const del = await pgClient.query(
    `DELETE FROM public.examination WHERE id = ANY($1::int[])`,
    [ids],
  );
  return del.rowCount ?? 0;
}

/**
 * exam ที่สร้าง: patient / exam_date ตามนัด (นัดย้ายจากคนไข้ K → คนจริง, เวลานัดเปลี่ยน)
 * @returns {Promise<number>} จำนวน exam ที่เปลี่ยน
 */
async function syncPlaceholderExams(pgClient, ph) {
  const p = quoteIdent(ph.examPatientCol);
  const sets = [`${p} = a.${quoteIdent(ph.aptPatientCol)}`];
  const diffs = [`e.${p} IS DISTINCT FROM a.${quoteIdent(ph.aptPatientCol)}`];
  if (ph.hasExamDate) {
    sets.push(`exam_date = ${ph.examDateExpr}`);
    diffs.push(`e.exam_date IS DISTINCT FROM ${ph.examDateExpr}`);
  }
  const upd = await pgClient.query(`
    UPDATE public.examination AS e
    SET ${sets.join(", ")}
    FROM public.nurse_work nw
    INNER JOIN public.appointment a ON a.id = nw.appointment
    WHERE nw.examination = e.id
      AND e.nurse_work = nw.id
      AND ${ph.bxAppointmentWhere}
      AND ${ph.isPlaceholder("e")}
      AND (${diffs.join(" OR ")})
  `);
  return upd.rowCount ?? 0;
}

/**
 * nurse_work ที่ migrate สร้างและยังไม่มี exam → สร้าง exam แบบ flow [id-87] แล้วผูก 2 ทาง
 * - exam ก่อนหน้า = exam ของคนไข้ที่มีนัด (appointment ไม่ว่าง) exam_date ไม่เกินเวลานัด ล่าสุด
 *   ไม่นับ exam ที่ migrate สร้าง (ไม่มีข้อมูลจริง)
 * - มี exam ก่อนหน้า → คัดลอก FLOW_ID87_COPY_FIELDS + exam_reason_type "Special Procedure"
 *   ไม่มี → แค่ nurse_work / appointment / patient / exam_date (ที่เหลือใช้ default ของตาราง —
 *   บางคอลัมน์ NOT NULL DEFAULT false จึงแยก INSERT ไม่ใส่ NULL ลงไป)
 * @returns {Promise<number>} จำนวน exam ที่สร้าง
 */
async function createPlaceholderExams(pgClient, ph) {
  const p = quoteIdent(ph.examPatientCol);
  const baseCols = ["nurse_work", "appointment", ph.examPatientCol];
  const baseExprs = ["s.nw_id", "s.appt_id", "s.patient"];
  if (ph.hasExamDate) {
    baseCols.push("exam_date");
    baseExprs.push("s.dt");
  }
  const skip = new Set([...baseCols, "exam_reason_type"]);
  const copyCols = FLOW_ID87_COPY_FIELDS.filter((c) => ph.examCols.has(c) && !skip.has(c));
  const prevCols = [...baseCols, ...copyCols.map(quoteIdent)];
  const prevExprs = [...baseExprs, ...copyCols.map((c) => `s.${quoteIdent(`p_${c}`)}`)];
  if (ph.examCols.has("exam_reason_type")) {
    prevCols.push("exam_reason_type");
    prevExprs.push(`'${FLOW_ID87_EXAM_REASON_TYPE}'::text`);
  }
  const baseColList = baseCols.map((c) => (c === ph.examPatientCol ? p : c)).join(", ");
  const prevColList = prevCols.map((c) => (c === ph.examPatientCol ? p : c)).join(", ");

  const r = await pgClient.query(`
    WITH tgt AS (
      SELECT nw.id AS nw_id, a.id AS appt_id,
             a.${quoteIdent(ph.aptPatientCol)} AS patient,
             ${ph.hasExamDate ? ph.examDateExpr : "NULL"} AS dt
      FROM public.nurse_work nw
      INNER JOIN public.appointment a ON a.id = nw.appointment
      WHERE nw.examination IS NULL
        AND ${ph.nwMigratedWhere}
        AND ${ph.bxAppointmentWhere}
        AND NOT EXISTS (SELECT 1 FROM public.examination x WHERE x.nurse_work = nw.id)
    ),
    src AS (
      SELECT t.*, prev.id AS prev_id
        ${copyCols.map((c) => `, prev.${quoteIdent(c)} AS ${quoteIdent(`p_${c}`)}`).join("")}
      FROM tgt t
      LEFT JOIN LATERAL (
        SELECT pe.*
        FROM public.examination pe
        WHERE t.patient IS NOT NULL
          AND pe.${p} = t.patient
          AND pe.appointment IS NOT NULL
          AND NOT (${ph.isPlaceholder("pe")})
          ${ph.hasExamDate ? "AND (t.dt IS NULL OR pe.exam_date <= t.dt)" : ""}
        ORDER BY ${ph.hasExamDate ? "pe.exam_date DESC NULLS LAST, " : ""}pe.id DESC
        LIMIT 1
      ) prev ON TRUE
    ),
    ins_prev AS (
      INSERT INTO public.examination (${prevColList})
      SELECT ${prevExprs.join(", ")}
      FROM src s
      WHERE s.prev_id IS NOT NULL
      ORDER BY s.nw_id
      RETURNING id, nurse_work
    ),
    ins_new AS (
      INSERT INTO public.examination (${baseColList})
      SELECT ${baseExprs.join(", ")}
      FROM src s
      WHERE s.prev_id IS NULL
      ORDER BY s.nw_id
      RETURNING id, nurse_work
    ),
    ins AS (
      SELECT id, nurse_work FROM ins_prev
      UNION ALL
      SELECT id, nurse_work FROM ins_new
    ),
    upd AS (
      UPDATE public.nurse_work AS nw
      SET examination = ins.id
      FROM ins
      WHERE nw.id = ins.nurse_work
      RETURNING 1
    )
    SELECT (SELECT count(*)::int FROM ins) AS n
  `);
  return Number(r.rows[0]?.n ?? 0);
}

/** ข้อความสรุปท้าย job — null = ไม่มีอะไรเปลี่ยน */
export function describeMigratedBxNurseWorkResult(result) {
  if (result == null) {
    return "nurse_work ของนัด BX: ข้าม (ปลายทางยังไม่มีตาราง/คอลัมน์ nurse_work ที่ต้องใช้)";
  }
  const {
    created,
    datetimeSynced,
    nurseWorkExamLinked,
    examNurseWorkLinked,
    examCreated = 0,
    examReplaced = 0,
    examSynced = 0,
  } = result;
  if (
    created === 0 &&
    datetimeSynced === 0 &&
    nurseWorkExamLinked === 0 &&
    examNurseWorkLinked === 0 &&
    examCreated === 0 &&
    examReplaced === 0 &&
    examSynced === 0
  ) {
    return null;
  }
  return `nurse_work ของนัด BX (inventional = 1 / request = bx): สร้างใหม่ ${created} แถว (status เสร็จสิ้น, bx_status 0, appointed_dept nurse; เติม appointment.department_bx = nurse ${result.departmentBxFilled ?? 0} แถว), sync เวลานัด ${datetimeSynced} แถว, ผูก exam → nurse_work.examination ${nurseWorkExamLinked} / examination.nurse_work ${examNurseWorkLinked} แถว; exam ที่สร้างให้ (แบบ flow [id-87]): สร้าง ${examCreated}, แทนด้วย exam จริง ${examReplaced}, sync คนไข้/เวลานัด ${examSynced} แถว`;
}
