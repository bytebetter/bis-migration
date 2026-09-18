/**
 * ตารางที่ migrate:all (resume) ใช้ checkpoint — profile → โฟลเดอร์ / ไฟล์ checkpoint / ตารางปลายทาง
 * ชื่อไฟล์ checkpoint = ของโหมด resume (migrateRowMode insert-only): appointment / examination มี -ins ต่อท้าย
 * (exam_recommend_birads45, birads_mass_cyst ไม่ใช้ checkpoint — อ่าน/คำนวณใหม่ทุกรอบ)
 */
import fs from "node:fs";
import path from "node:path";

export const RESUME_CHECKPOINT_TABLES = {
  patient_info: { dir: "patient-info", checkpoint: "patient_info", target: "patient_info" },
  appointment: { dir: "appointment", checkpoint: "appointment-ins", target: "appointment" },
  appointment_reschedules: { dir: "appointment-reschedules", checkpoint: "appointment_reschedules", target: "appointment_reschedules" },
  examination: { dir: "examination", checkpoint: "examination-ins", target: "examination" },
  billing: { dir: "billing", checkpoint: "billing", target: "billing" },
  examination_general: { dir: "examination-general", checkpoint: "examination_general", target: "examination_general" },
  pacs_sync_info: { dir: "pacs-sync-info", checkpoint: "pacs_sync_info", target: "pacs_sync_info" },
  procedure: { dir: "procedure", checkpoint: "procedure", target: "procedure" },
  ultrasound: { dir: "ultrasound", checkpoint: "ultrasound", target: "ultrasound" },
  mam: { dir: "mam", checkpoint: "mam", target: "mammogram" },
  mam_cal: { dir: "mam-cal", checkpoint: "mam_cal", target: "mammogram_cal", child: "Described_Cal_ID" },
  mam_mass: { dir: "mam-mass", checkpoint: "mam_mass", target: "mammogram_mass", child: "Described_Mass_ID" },
  ultrasound_cyst: { dir: "ultrasound-cyst", checkpoint: "ultrasound_cyst", target: "ultrasound_cyst", child: "Described_Cyst_ID" },
  ultrasound_mass: { dir: "ultrasound-mass", checkpoint: "ultrasound_mass", target: "ultrasound_mass", child: "Described_Mass_ID" },
  pacs_sync_patient: { dir: "pacs-sync-patient", checkpoint: "pacs_sync_patient", target: "pacs_sync_patient" },
};

/**
 * @param {string} repoRoot
 * @param {string} profile
 * @param {string | undefined} checkpointDir migration.checkpointDir ของ profile (ถ้ามี)
 */
export function resumeCheckpointPath(repoRoot, profile, checkpointDir) {
  const t = RESUME_CHECKPOINT_TABLES[profile];
  return path.join(
    path.resolve(repoRoot, t.dir, "js-migrate", checkpointDir ?? "./checkpoints"),
    `${t.checkpoint}.json`,
  );
}

/**
 * ให้ checkpoint ไปด้วยกันกับข้อมูลปลายทาง
 * - ปลายทางว่าง + มี checkpoint → ย้าย checkpoint เป็น .bak-<stamp> (ตารางนั้นเริ่มใหม่)
 * - ปลายทางมีข้อมูล + ไม่มี checkpoint → คืนใน missing (ผู้เรียกต้องหยุด)
 * dryRun: รายงานอย่างเดียว ไม่ย้ายไฟล์ (preflight)
 * @param {{ client: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }, repoRoot: string, profiles: string[], checkpointDirOf?: (profile: string) => string | undefined, stamp: string, log?: (msg: string) => void, dryRun?: boolean }} p
 * @returns {Promise<{ moved: { profile: string, from: string, to: string }[], missing: { profile: string, target: string, file: string }[] }>}
 */
export async function alignResumeCheckpointsWithTarget(p) {
  const {
    client,
    repoRoot,
    profiles,
    checkpointDirOf = () => undefined,
    stamp,
    log = () => {},
    dryRun = false,
  } = p;
  const moved = [];
  const missing = [];
  for (const profile of profiles) {
    const t = RESUME_CHECKPOINT_TABLES[profile];
    if (!t) continue;
    const file = resumeCheckpointPath(repoRoot, profile, checkpointDirOf(profile));
    const exists = await client.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [
      `public."${t.target}"`,
    ]);
    let hasRows = false;
    if (exists.rows[0]?.ok) {
      const r = await client.query(
        `SELECT EXISTS (SELECT 1 FROM public."${t.target}") AS has_rows`,
      );
      hasRows = r.rows[0]?.has_rows === true;
    }
    const hasCheckpoint = fs.existsSync(file);
    if (!hasRows && hasCheckpoint) {
      const to = `${file}.bak-${stamp}`;
      if (!dryRun) fs.renameSync(file, to);
      moved.push({ profile, from: file, to });
      log(
        `>>> [checkpoint] ${profile}: public.${t.target} ว่าง — ${dryRun ? "จะย้าย" : "ย้าย"} checkpoint ไป ${path.basename(to)} (ตารางนี้เริ่มใหม่ทั้งตาราง)`,
      );
    } else if (hasRows && !hasCheckpoint) {
      missing.push({ profile, target: t.target, file });
    }
  }
  return { moved, missing };
}
