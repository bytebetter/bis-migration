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
 */

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

/**
 * @returns {Promise<{
 *   created: number,
 *   departmentBxFilled: number,
 *   datetimeSynced: number,
 *   nurseWorkExamLinked: number,
 *   examNurseWorkLinked: number,
 * } | null>} null = ปลายทางยังไม่มีตาราง/คอลัมน์ที่ต้องใช้ (ข้าม)
 * @param {{ linkExamOnly?: boolean }} [options]
 *   linkExamOnly = ผูก exam อย่างเดียว (job examination ไม่ได้เพิ่มนัด/เปลี่ยนเวลานัด —
 *   ข้าม 2 query ที่สแกน appointment ทั้งตาราง)
 */
export async function syncMigratedBxNurseWork(pgClient, options = {}) {
  const linkExamOnly = options.linkExamOnly === true;
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
  const examCols = await tableColumns(pgClient, "examination");
  if (
    nwCols.has("examination") &&
    examCols.has("appointment") &&
    examCols.has("nurse_work") &&
    examCols.has("old_exam_id")
  ) {
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
  }

  return {
    created: Number(created?.rows[0]?.n ?? 0),
    departmentBxFilled: Number(created?.rows[0]?.dept_filled ?? 0),
    datetimeSynced,
    nurseWorkExamLinked,
    examNurseWorkLinked,
  };
}

/** ข้อความสรุปท้าย job — null = ไม่มีอะไรเปลี่ยน */
export function describeMigratedBxNurseWorkResult(result) {
  if (result == null) {
    return "nurse_work ของนัด BX: ข้าม (ปลายทางยังไม่มีตาราง/คอลัมน์ nurse_work ที่ต้องใช้)";
  }
  const { created, datetimeSynced, nurseWorkExamLinked, examNurseWorkLinked } =
    result;
  if (
    created === 0 &&
    datetimeSynced === 0 &&
    nurseWorkExamLinked === 0 &&
    examNurseWorkLinked === 0
  ) {
    return null;
  }
  return `nurse_work ของนัด BX (inventional = 1 / request = bx): สร้างใหม่ ${created} แถว (status เสร็จสิ้น, bx_status 0, appointed_dept nurse; เติม appointment.department_bx = nurse ${result.departmentBxFilled ?? 0} แถว), sync เวลานัด ${datetimeSynced} แถว, ผูก exam → nurse_work.examination ${nurseWorkExamLinked} / examination.nurse_work ${examNurseWorkLinked} แถว`;
}
