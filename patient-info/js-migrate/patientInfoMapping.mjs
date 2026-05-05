/**
 * แมป staging row / แถวจาก MSSQL → public.patient_info + public.address
 * (รูปแบบเดิมจาก sql/02, sql/03 — ย้ายมา JS เพื่อขยาย logic ต่อ)
 */

/** MSSQL `CONVERT(..., 126)` → ISO prefix `YYYY-MM-DD` (Gregorian / ค.ศ.) */
const DATE_ISO_YMD_PREFIX = /^[0-9]{4}-[0-9]{2}-[0-9]{2}/;
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

/** public.patient_info / public.address ใช้ varchar(255) — MSSQL text ยาวกว่าได้ */
function clampText255(v) {
  const t = nullIfTrimEmpty(v);
  if (t == null) return null;
  return t.length <= 255 ? t : t.slice(0, 255);
}

/** วันเกิดจากต้นทางเป็น ค.ศ. แล้ว — ส่งต่อเป็น `YYYY-MM-DD` สำหรับ `::date` โดยไม่แปลง พ.ศ. */
function parseDateOfBirthGregorian(raw) {
  if (raw == null) return null;
  const t = String(raw).trim();
  if (t === "" || !DATE_ISO_YMD_PREFIX.test(t)) return null;
  const y = Number.parseInt(t.slice(0, 4), 10);
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

function normSocId(v) {
  const t = nullIfTrimEmpty(v);
  if (t == null) return null;
  const digits = String(t).replace(/\D/g, "");
  return digits === "" ? null : digits;
}

function isHomePrefix(p2) {
  return p2 === "02" || p2 === "03" || p2 === "04";
}

function isBizPrefix(p2) {
  return p2 === "06" || p2 === "07" || p2 === "08" || p2 === "09";
}

/**
 * Extract Thai phone-like numbers from a raw chunk.
 * - Ignore non-digits.
 * - Prefer well-formed patterns:
 *   - home: 0[2-4] + 7 digits (9 total)
 *   - biz/mobile: 0[6-9] + 8 digits (10 total)
 */
function extractThaiPhonesFromChunk(rawChunk) {
  if (rawChunk == null) return [];
  const digits = String(rawChunk).replace(/\D/g, "");
  if (digits === "") return [];

  /** @type {string[]} */
  const out = [];

  // Prefer explicit matches inside longer digit strings (handles stray characters/ext).
  for (const m of digits.matchAll(/0[234]\d{7}/g)) out.push(m[0]);
  for (const m of digits.matchAll(/0[6789]\d{8}/g)) out.push(m[0]);

  if (out.length > 0) return out;

  // Fallback: if it's a single number-like, keep a reasonable length.
  const p2 = digits.slice(0, 2);
  if (isBizPrefix(p2) && digits.length >= 10) return [digits.slice(0, 10)];
  if (isHomePrefix(p2) && digits.length >= 9) return [digits.slice(0, 9)];
  if (digits.length === 10 || digits.length === 9) return [digits];
  if (digits.length > 10) return [digits.slice(0, 10)];
  if (digits.length > 9) return [digits.slice(0, 9)];
  return [];
}

function splitAndExtractThaiPhones(raw) {
  if (raw == null) return [];
  const t = String(raw).trim();
  if (t === "") return [];

  // Split by "/" first (per requirement), but still robust if multiple slashes/spaces exist.
  const parts = t.split("/").map((p) => p.trim()).filter((p) => p !== "");
  if (parts.length === 0) return [];

  /** @type {string[]} */
  const out = [];
  for (const p of parts) out.push(...extractThaiPhonesFromChunk(p));
  return out;
}

function normalizeAndDistributePhones(rawBiz, rawHome) {
  const bizExisting = nullIfTrimEmpty(rawBiz);
  const homeExisting = nullIfTrimEmpty(rawHome);

  // If nothing suggests splitting/re-mapping, keep original behavior.
  const needsReMap =
    (bizExisting != null && String(bizExisting).includes("/")) ||
    (homeExisting != null && String(homeExisting).includes("/"));

  if (!needsReMap) {
    return { phone_biz: bizExisting, phone_home: homeExisting };
  }

  const candidates = [
    ...splitAndExtractThaiPhones(bizExisting),
    ...splitAndExtractThaiPhones(homeExisting),
  ];

  let biz = null;
  let home = null;

  for (const ph of candidates) {
    if (ph.length < 2) continue;
    const p2 = ph.slice(0, 2);
    if (home == null && isHomePrefix(p2)) {
      home = ph;
      continue;
    }
    if (biz == null && isBizPrefix(p2)) {
      biz = ph;
      continue;
    }
  }

  // If we couldn't classify, fall back to original values.
  return {
    phone_biz: biz ?? bizExisting,
    phone_home: home ?? homeExisting,
  };
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
    aPreTh.push(clampText255(getField(r, "prefix")));
    aFnTh.push(clampText255(getField(r, "name")));
    aLnTh.push(clampText255(getField(r, "surname")));
    const d = parseDateOfBirthGregorian(getField(r, "date_of_birth_be"));
    aDob.push(d);
    aMar.push(clampText255(getField(r, "single")));
    const { phone_biz, phone_home } = normalizeAndDistributePhones(
      getField(r, "phone_biz"),
      getField(r, "phone_home")
    );
    aPhBiz.push(clampText255(phone_biz));
    aPhHome.push(clampText255(phone_home));
    const h = parseReal(getField(r, "height"));
    aH.push(h == null || Number.isNaN(h) ? null : h);
    const w = parseReal(getField(r, "weight"));
    aW.push(w == null || Number.isNaN(w) ? null : w);
    const dnt = parseDonateTypeInt(getField(r, "donate_type"));
    aDon.push(dnt);
    aPreEn.push(clampText255(getField(r, "eng_prefix")));
    aFnEn.push(clampText255(getField(r, "eng_name")));
    aLnEn.push(clampText255(getField(r, "eng_surname")));
    aSoc.push(clampText255(normSocId(getField(r, "soc_id"))));
    aHn.push(clampText255(getField(r, "hn")));
    aGen.push(clampText255(getField(r, "gender")));
    aNote.push(clampText255(getField(r, "short_note")));
    aDis.push(clampText255(getField(r, "disease")));
    aMobile.push(clampText255(getField(r, "mobile_phone")));
    aEmail.push(clampText255(getField(r, "email")));
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
    adAddr.push(clampText255(getField(r, "address")));
    adSub.push(clampText255(getField(r, "sub_area")));
    adDist.push(clampText255(getField(r, "area")));
    adProv.push(clampText255(getField(r, "province")));
    adZip.push(clampText255(getField(r, "zip")));
    ad2.push(clampText255(getField(r, "address2")));
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

  const insAddress = await pgClient.query(
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
    RETURNING id, patient_info
    `,
    [st, adAddr, adSub, adDist, adProv, adZip, ad2, adPat, fromOld]
  );

  // If patient_info has a FK back to address (e.g. address_id), populate it.
  // This keeps relations usable in apps/ORMs that model it bidirectionally.
  const piHasAddressId = await pgClient.query(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'patient_info'
      AND column_name = 'address_id'
    LIMIT 1
    `,
  );
  if (piHasAddressId.rowCount > 0 && insAddress.rows.length > 0) {
    const addrIds = insAddress.rows.map((r) => r.id);
    const piIds = insAddress.rows.map((r) => r.patient_info);
    await pgClient.query(
      `
      UPDATE public.patient_info p
      SET address_id = x.address_id
      FROM (
        SELECT * FROM unnest($1::int[], $2::int[]) AS t(address_id, patient_info_id)
      ) x
      WHERE p.id = x.patient_info_id
      `,
      [addrIds, piIds],
    );
  }
}
