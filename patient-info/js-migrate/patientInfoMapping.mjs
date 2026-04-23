/**
 * แมป staging row / แถวจาก MSSQL → public.patient_info + public.address
 * (รูปแบบเดิมจาก sql/02, sql/03 — ย้ายมา JS เพื่อขยาย logic ต่อ)
 */

const DATE_BE_DMY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}/;
const NUM_RE = /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;
const INT_RE = /^[0-9]+$/;

function getField(row, key) {
  return row[key] ?? row[key.toLowerCase()] ?? row[key.toUpperCase()];
}

/** เทียบเท่า migrate_stg.norm_pid: trim + ตัด BOM */
export function normPid(v) {
  if (v == null) return "";
  return String(v).replace(/^\uFEFF/, "").trim();
}

function nullIfTrimEmpty(v) {
  if (v == null) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
}

function parseDateOfBirthBe(raw) {
  if (raw == null) return null;
  const t = String(raw).trim();
  if (t === "" || !DATE_BE_DMY.test(t)) return null;
  const y = Number.parseInt(t.slice(0, 4), 10) - 543;
  const m = Number.parseInt(t.slice(5, 7), 10);
  const d = Number.parseInt(t.slice(8, 10), 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseReal(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (t === "" || !NUM_RE.test(t)) return null;
  return Number.parseFloat(t);
}

function parseDonateTypeInt(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (t === "" || !INT_RE.test(t)) return null;
  return Number.parseInt(t, 10);
}

/**
 * คัดแถวซ้ำ pid (เทียบ norm_pid) ให้ลำดับแรกชนะ — เทียบ DISTINCT ON
 */
export function distinctOnNormPid(mssqlRows) {
  const seen = new Map();
  for (const r of mssqlRows) {
    const np = normPid(getField(r, "pid"));
    if (np === "") continue;
    if (!seen.has(np)) seen.set(np, r);
  }
  return Array.from(seen.values());
}

function hasAddressPayload(row) {
  return (
    nullIfTrimEmpty(getField(row, "address")) != null ||
    nullIfTrimEmpty(getField(row, "sub_area")) != null ||
    nullIfTrimEmpty(getField(row, "area")) != null ||
    nullIfTrimEmpty(getField(row, "province")) != null ||
    nullIfTrimEmpty(getField(row, "zip")) != null ||
    nullIfTrimEmpty(getField(row, "address2")) != null
  );
}

/**
 * ลบ/แทรกแถวต่อ chunk: address → patient → setval → insert patient → setval → insert address
 * @param {import("pg").PoolClient} pgClient
 * @param {object[]} mssqlRows แถวดิบจาก recordset
 */
export async function runPatientInfoChunkPostLoad(pgClient, mssqlRows) {
  const rows = distinctOnNormPid(mssqlRows);
  if (rows.length === 0) return;

  const npids = rows.map((r) => normPid(getField(r, "pid"))).filter((n) => n !== "");

  await pgClient.query(
    `
    DELETE FROM public.address a
    WHERE a.patient_info IN (
      SELECT p.id
      FROM public.patient_info p
      WHERE migrate_stg.norm_pid(p.pid::text) = ANY($1::text[])
    )
    `,
    [npids]
  );

  await pgClient.query(
    `
    DELETE FROM public.patient_info p
    WHERE migrate_stg.norm_pid(p.pid::text) = ANY($1::text[])
    `,
    [npids]
  );

  await pgClient.query(`
    SELECT setval(
      pg_get_serial_sequence('public.patient_info', 'id'),
      COALESCE((SELECT MAX(id) + 1 FROM public.patient_info), 1),
      false
    );
  `);

  const aOld = [];
  const aPid = [];
  const aPreTh = [];
  const aFnTh = [];
  const aLnTh = [];
  const aDob = [];
  const aMar = [];
  const aPhBiz = [];
  const aPhHome = [];
  const aH = [];
  const aW = [];
  const aDon = [];
  const aPreEn = [];
  const aFnEn = [];
  const aLnEn = [];
  const aSoc = [];
  const aHn = [];
  const aGen = [];
  const aNote = [];
  const aDis = [];
  const aMobile = [];
  const aEmail = [];

  for (const r of rows) {
    const np = normPid(getField(r, "pid"));
    aOld.push(np);
    aPid.push(np);
    aPreTh.push(nullIfTrimEmpty(getField(r, "prefix")));
    aFnTh.push(nullIfTrimEmpty(getField(r, "name")));
    aLnTh.push(nullIfTrimEmpty(getField(r, "surname")));
    const d = parseDateOfBirthBe(getField(r, "date_of_birth_be"));
    aDob.push(d);
    aMar.push(nullIfTrimEmpty(getField(r, "single")));
    aPhBiz.push(nullIfTrimEmpty(getField(r, "phone_biz")));
    aPhHome.push(nullIfTrimEmpty(getField(r, "phone_home")));
    const h = parseReal(getField(r, "height"));
    aH.push(h == null || Number.isNaN(h) ? null : h);
    const w = parseReal(getField(r, "weight"));
    aW.push(w == null || Number.isNaN(w) ? null : w);
    const dnt = parseDonateTypeInt(getField(r, "donate_type"));
    aDon.push(dnt);
    aPreEn.push(nullIfTrimEmpty(getField(r, "eng_prefix")));
    aFnEn.push(nullIfTrimEmpty(getField(r, "eng_name")));
    aLnEn.push(nullIfTrimEmpty(getField(r, "eng_surname")));
    aSoc.push(nullIfTrimEmpty(getField(r, "soc_id")));
    aHn.push(nullIfTrimEmpty(getField(r, "hn")));
    aGen.push(nullIfTrimEmpty(getField(r, "gender")));
    aNote.push(nullIfTrimEmpty(getField(r, "short_note")));
    aDis.push(nullIfTrimEmpty(getField(r, "disease")));
    aMobile.push(nullIfTrimEmpty(getField(r, "mobile_phone")));
    aEmail.push(nullIfTrimEmpty(getField(r, "email")));
  }

  const ins = await pgClient.query(
    `
    INSERT INTO public.patient_info (
      old_db_id,
      pid,
      prefix_th,
      first_name_th,
      last_name_th,
      date_of_birth,
      marital_status,
      phone_biz,
      phone_home,
      height,
      weight,
      donate_type,
      prefix_en,
      first_name_en,
      last_name_en,
      soc_id,
      hn,
      gender,
      short_note,
      disease,
      mobile_phone,
      email
    )
    SELECT * FROM unnest(
      $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::date[],
      $7::text[], $8::text[], $9::text[], $10::float4[], $11::float4[], $12::int[],
      $13::text[], $14::text[], $15::text[], $16::text[], $17::text[], $18::text[],
      $19::text[], $20::text[], $21::text[], $22::text[]
    ) AS t(
      old_db_id, pid, prefix_th, first_name_th, last_name_th, date_of_birth, marital_status,
      phone_biz, phone_home, height, weight, donate_type, prefix_en, first_name_en, last_name_en,
      soc_id, hn, gender, short_note, disease, mobile_phone, email
    )
    RETURNING id, pid::text
    `,
    [
      aOld,
      aPid,
      aPreTh,
      aFnTh,
      aLnTh,
      aDob,
      aMar,
      aPhBiz,
      aPhHome,
      aH,
      aW,
      aDon,
      aPreEn,
      aFnEn,
      aLnEn,
      aSoc,
      aHn,
      aGen,
      aNote,
      aDis,
      aMobile,
      aEmail
    ]
  );

  const idByNpid = new Map();
  for (const r of ins.rows) {
    idByNpid.set(normPid(r.pid), r.id);
  }

  const adAddr = [];
  const adSub = [];
  const adDist = [];
  const adProv = [];
  const adZip = [];
  const ad2 = [];
  const adPat = [];

  for (const r of rows) {
    if (!hasAddressPayload(r)) continue;
    const np = normPid(getField(r, "pid"));
    const id = idByNpid.get(np);
    if (id == null) continue;
    adAddr.push(nullIfTrimEmpty(getField(r, "address")));
    adSub.push(nullIfTrimEmpty(getField(r, "sub_area")));
    adDist.push(nullIfTrimEmpty(getField(r, "area")));
    adProv.push(nullIfTrimEmpty(getField(r, "province")));
    adZip.push(nullIfTrimEmpty(getField(r, "zip")));
    ad2.push(nullIfTrimEmpty(getField(r, "address2")));
    adPat.push(id);
  }

  if (adPat.length === 0) return;

  await pgClient.query(`
    SELECT setval(
      pg_get_serial_sequence('public.address', 'id'),
      COALESCE((SELECT MAX(id) + 1 FROM public.address), 1),
      false
    );
  `);

  const n = adPat.length;
  const st = Array(n).fill("published");
  const fromOld = Array(n).fill(true);

  await pgClient.query(
    `
    INSERT INTO public.address (
      status,
      address,
      sub_district,
      district,
      province,
      zipcode,
      address2,
      patient_info,
      from_old_db
    )
    SELECT * FROM unnest(
      $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
      $8::int[], $9::boolean[]
    ) AS t(
      status, address, sub_district, district, province, zipcode, address2, patient_info, from_old_db
    )
    `,
    [st, adAddr, adSub, adDist, adProv, adZip, ad2, adPat, fromOld]
  );
}
