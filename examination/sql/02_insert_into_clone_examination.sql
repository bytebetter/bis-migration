-- แปลง migrate_stg.examination_mssql -> public.examination
-- เงื่อนไข: มี public.patient_info แล้ว (จับคู่ PID); Schedule_ID จับกับ public.appointment.id ถ้าตรง
-- ชนิดคอลัมน์ปลายทางต้องตรงกับ public.examination (เทียบกับ Directus/Postgres)
-- ดูรายการจริง: sql/reference_public_examination_schema.sql
--
-- รันหลัง 01_create_staging.sql

BEGIN;

DELETE FROM public.examination e
WHERE e.old_exam_id IN (
  SELECT DISTINCT (NULLIF(migrate_stg.norm_exam_id(s.exam_id), '')::bigint)::text
  FROM migrate_stg.examination_mssql s
  WHERE NULLIF(migrate_stg.norm_exam_id(s.exam_id), '') ~ '^[0-9]+$'
);

SELECT setval(
  pg_get_serial_sequence('public.examination', 'id'),
  COALESCE((SELECT MAX(id) + 1 FROM public.examination), 1),
  false
);

INSERT INTO public.examination (
  old_exam_id,
  old_pid,
  patient,
  exam_date,
  tech_login_name,
  mobile,
  mobile_update,
  menstruation_age,
  menopause_age,
  first_pregnancy_age,
  num_pregnancy,
  cont_use,
  cont_yrs,
  hormone_use,
  hormone_yrs,
  hysterectomy,
  ovaries_removed,
  pregnant,
  referring_md,
  referring_hospital,
  prev_mammo_date,
  prev_mammo_loc,
  sister_cancer_age,
  mother_cancer_age,
  grandmother_cancer_age,
  other_cancer_age,
  biopsy_l_date,
  biopsy_r_date,
  chemo_l_date,
  chemo_r_date,
  cyst_l_date,
  cyst_r_date,
  irr_l_date,
  irr_r_date,
  lump_l_date,
  lump_r_date,
  mast_l_date,
  mast_r_date,
  rad_l_date,
  rad_r_date,
  num_left_mass,
  num_right_mass,
  lnwn,
  lnww,
  ln,
  lnen,
  lnee,
  le,
  lm,
  lw,
  lsws,
  lsww,
  ls,
  lses,
  lsee,
  rnwn,
  rnww,
  rn,
  rnen,
  rnee,
  re,
  rm,
  rw,
  rsws,
  rsww,
  rs,
  rses,
  rsee,
  lother,
  rother,
  l_axillar,
  r_axillar,
  exam_reason,
  exam_reason_text,
  exam_reason_memotext,
  pain_l_duration,
  pain_r_duration,
  mobile_updated,
  mobile_loc,
  bct_l_date,
  bct_r_date,
  patient_cancer_age,
  daughter_cancer_age,
  daughter_cancer_age_more,
  sister_cancer_age_more,
  other_cancer_age_more,
  stophormone_yrs,
  ca_hormone_use,
  ca_hormone_yrs,
  stop_ca_hormone_yrs,
  stop_contr_yrs,
  rm_l_date,
  rm_r_date,
  ri_l_date,
  ri_r_date,
  fna_l_date,
  fna_r_date,
  fnx_l_date,
  fnx_r_date,
  send_exam_login_name,
  appointment
)
SELECT
  (NULLIF(migrate_stg.norm_exam_id(s.exam_id), '')::bigint)::text AS old_exam_id,
  NULLIF(migrate_stg.norm_pid(s.pid), '') AS old_pid,
  p.id AS patient,
  migrate_stg.mssql_be_datetime_to_timestamp(s.exam_date) AS exam_date,
  NULLIF(trim(s.tech_login_name), '') AS tech_login_name,
  migrate_stg.mssql_01_text_to_bool(s.mobile) AS mobile,
  migrate_stg.mssql_01_text_to_bool(s.mobile_update) AS mobile_update,
  NULLIF(trim(s.menstruation_age), '') AS menstruation_age,
  NULLIF(trim(s.menopause_age), '') AS menopause_age,
  NULLIF(trim(s.first_pregnancy_age), '') AS first_pregnancy_age,
  NULLIF(trim(s.num_pregnancy), '') AS num_pregnancy,
  migrate_stg.mssql_01_text_to_bool(s.cont_use) AS cont_use,
  NULLIF(trim(s.cont_yrs), '') AS cont_yrs,
  migrate_stg.mssql_01_text_to_bool(s.hormone_use) AS hormone_use,
  NULLIF(trim(s.hormone_yrs), '') AS hormone_yrs,
  migrate_stg.mssql_01_text_to_bool(s.hysterectomy) AS hysterectomy,
  migrate_stg.mssql_01_text_to_bool(s.ovaries_removed) AS ovaries_removed,
  migrate_stg.mssql_01_text_to_bool(s.pragnant) AS pregnant,
  CASE
    WHEN NULLIF(trim(s.referring_md), '') IS NOT NULL
      AND trim(s.referring_md) ~ '^-?[0-9]+$'
    THEN trim(s.referring_md)::integer
    ELSE NULL
  END AS referring_md,
  NULLIF(trim(s.referring_hospital), '') AS referring_hospital,
  migrate_stg.mssql_be_datetime_to_timestamp(s.prev_mammo_date) AS prev_mammo_date,
  NULLIF(trim(s.prev_mammo_loc), '') AS prev_mammo_loc,
  NULLIF(trim(s.sister_cancer_age), '') AS sister_cancer_age,
  NULLIF(trim(s.mother_cancer_age), '') AS mother_cancer_age,
  NULLIF(trim(s.grandmother_cancer_age), '') AS grandmother_cancer_age,
  NULLIF(trim(s.other_cancer_age), '') AS other_cancer_age,
  migrate_stg.mssql_be_datetime_to_timestamp(s.biopsy_l_date) AS biopsy_l_date,
  migrate_stg.mssql_be_datetime_to_timestamp(s.biopsy_r_date) AS biopsy_r_date,
  migrate_stg.mssql_be_datetime_to_timestamp(s.chemo_l_date) AS chemo_l_date,
  migrate_stg.mssql_be_datetime_to_timestamp(s.chemo_r_date) AS chemo_r_date,
  migrate_stg.mssql_be_datetime_to_timestamp(s.cyst_l_date) AS cyst_l_date,
  migrate_stg.mssql_be_datetime_to_timestamp(s.cyst_r_date) AS cyst_r_date,
  migrate_stg.mssql_be_datetime_to_timestamp(s.irr_l_date) AS irr_l_date,
  migrate_stg.mssql_be_datetime_to_timestamp(s.irr_r_date) AS irr_r_date,
  migrate_stg.mssql_be_datetime_to_timestamp(s.lump_l_date) AS lump_l_date,
  migrate_stg.mssql_be_datetime_to_timestamp(s.lump_r_date) AS lump_r_date,
  migrate_stg.mssql_be_datetime_to_timestamp(s.mast_l_date) AS mast_l_date,
  migrate_stg.mssql_be_datetime_to_timestamp(s.mast_r_date) AS mast_r_date,
  migrate_stg.mssql_be_datetime_to_timestamp(s.rad_l_date) AS rad_l_date,
  migrate_stg.mssql_be_datetime_to_timestamp(s.rad_r_date) AS rad_r_date,
  NULLIF(trim(s.num_left_mass), '') AS num_left_mass,
  NULLIF(trim(s.num_right_mass), '') AS num_right_mass,
  migrate_stg.mssql_01_text_to_bool(s.lnwn) AS lnwn,
  migrate_stg.mssql_01_text_to_bool(s.lnww) AS lnww,
  migrate_stg.mssql_01_text_to_bool(s.ln) AS ln,
  migrate_stg.mssql_01_text_to_bool(s.lnen) AS lnen,
  migrate_stg.mssql_01_text_to_bool(s.lnee) AS lnee,
  migrate_stg.mssql_01_text_to_bool(s.le) AS le,
  migrate_stg.mssql_01_text_to_bool(s.lm) AS lm,
  migrate_stg.mssql_01_text_to_bool(s.lw) AS lw,
  migrate_stg.mssql_01_text_to_bool(s.lsws) AS lsws,
  migrate_stg.mssql_01_text_to_bool(s.lsww) AS lsww,
  migrate_stg.mssql_01_text_to_bool(s.ls) AS ls,
  migrate_stg.mssql_01_text_to_bool(s.lses) AS lses,
  migrate_stg.mssql_01_text_to_bool(s.lsee) AS lsee,
  migrate_stg.mssql_01_text_to_bool(s.rnwn) AS rnwn,
  migrate_stg.mssql_01_text_to_bool(s.rnww) AS rnww,
  migrate_stg.mssql_01_text_to_bool(s.rn) AS rn,
  migrate_stg.mssql_01_text_to_bool(s.rnen) AS rnen,
  migrate_stg.mssql_01_text_to_bool(s.rnee) AS rnee,
  migrate_stg.mssql_01_text_to_bool(s.re) AS re,
  migrate_stg.mssql_01_text_to_bool(s.rm) AS rm,
  migrate_stg.mssql_01_text_to_bool(s.rw) AS rw,
  migrate_stg.mssql_01_text_to_bool(s.rsws) AS rsws,
  migrate_stg.mssql_01_text_to_bool(s.rsww) AS rsww,
  migrate_stg.mssql_01_text_to_bool(s.rs) AS rs,
  migrate_stg.mssql_01_text_to_bool(s.rses) AS rses,
  migrate_stg.mssql_01_text_to_bool(s.rsee) AS rsee,
  migrate_stg.mssql_01_text_to_bool(s.lother) AS lother,
  migrate_stg.mssql_01_text_to_bool(s.rother) AS rother,
  migrate_stg.mssql_01_text_to_bool(s.l_axillar) AS l_axillar,
  migrate_stg.mssql_01_text_to_bool(s.r_axillar) AS r_axillar,
  CASE
    WHEN NULLIF(trim(s.exam_reason), '') IS NOT NULL
      AND trim(s.exam_reason) ~ '^-?[0-9]+$'
    THEN trim(s.exam_reason)::integer
    ELSE NULL
  END AS exam_reason,
  NULLIF(trim(s.exam_reason_text), '') AS exam_reason_text,
  NULLIF(trim(s.exam_reason_memotext), '') AS exam_reason_memotext,
  NULLIF(trim(s.pain_l_duration), '') AS pain_l_duration,
  NULLIF(trim(s.pain_r_duration), '') AS pain_r_duration,
  EXTRACT(EPOCH FROM migrate_stg.mssql_be_datetime_to_timestamp(s.mobile_updated))::integer AS mobile_updated,
  CASE
    WHEN NULLIF(trim(s.mobile_loc), '') IS NOT NULL
      AND trim(s.mobile_loc) ~ '^-?[0-9]+$'
    THEN trim(s.mobile_loc)::integer
    ELSE NULL
  END AS mobile_loc,
  migrate_stg.mssql_be_datetime_to_timestamp(s.bct_l_date) AS bct_l_date,
  migrate_stg.mssql_be_datetime_to_timestamp(s.bct_r_date) AS bct_r_date,
  CASE
    WHEN NULLIF(trim(s.patient_cancer_age), '') IS NOT NULL
      AND trim(s.patient_cancer_age) ~ '^-?[0-9]+$'
    THEN trim(s.patient_cancer_age)::integer
    ELSE NULL
  END AS patient_cancer_age,
  NULLIF(trim(s.daughter_cancer_age), '') AS daughter_cancer_age,
  migrate_stg.mssql_01_text_to_bool(s.daughter_cancer_age_more) AS daughter_cancer_age_more,
  migrate_stg.mssql_01_text_to_bool(s.sister_cancer_age_more) AS sister_cancer_age_more,
  migrate_stg.mssql_01_text_to_bool(s.other_cancer_age_more) AS other_cancer_age_more,
  NULLIF(trim(s.stophormone_yrs), '') AS stophormone_yrs,
  migrate_stg.mssql_01_text_to_bool(s.ca_hormone_use) AS ca_hormone_use,
  NULLIF(trim(s.ca_hormone_yrs), '') AS ca_hormone_yrs,
  NULLIF(trim(s.stop_ca_hormone_yrs), '') AS stop_ca_hormone_yrs,
  NULLIF(trim(s.stop_contr_yrs), '') AS stop_contr_yrs,
  migrate_stg.mssql_be_datetime_to_timestamp(s.rm_l_date) AS rm_l_date,
  migrate_stg.mssql_be_datetime_to_timestamp(s.rm_r_date) AS rm_r_date,
  migrate_stg.mssql_be_datetime_to_timestamp(s.ri_l_date) AS ri_l_date,
  migrate_stg.mssql_be_datetime_to_timestamp(s.ri_r_date) AS ri_r_date,
  migrate_stg.mssql_be_datetime_to_timestamp(s.fna_l_date) AS fna_l_date,
  migrate_stg.mssql_be_datetime_to_timestamp(s.fna_r_date) AS fna_r_date,
  migrate_stg.mssql_be_datetime_to_timestamp(s.fnx_l_date) AS fnx_l_date,
  migrate_stg.mssql_be_datetime_to_timestamp(s.fnx_r_date) AS fnx_r_date,
  NULLIF(trim(s.send_exam_login_name), '') AS send_exam_login_name,
  ap.id AS appointment
FROM (
  SELECT DISTINCT ON (migrate_stg.norm_exam_id(s.exam_id))
    s.*
  FROM migrate_stg.examination_mssql s
  WHERE NULLIF(migrate_stg.norm_exam_id(s.exam_id), '') <> ''
    AND NULLIF(migrate_stg.norm_exam_id(s.exam_id), '') ~ '^[0-9]+$'
  ORDER BY migrate_stg.norm_exam_id(s.exam_id)
) s
JOIN public.patient_info p
  ON migrate_stg.norm_pid(p.pid::text) = migrate_stg.norm_pid(s.pid)
LEFT JOIN public.appointment ap
  ON ap.id = CASE
    WHEN NULLIF(trim(s.schedule_id), '') IS NOT NULL
      AND trim(s.schedule_id) ~ '^[0-9]+$'
    THEN trim(s.schedule_id)::integer
    ELSE NULL
  END
WHERE migrate_stg.norm_pid(s.pid) <> '';

COMMIT;
