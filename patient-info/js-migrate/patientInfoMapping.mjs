import { isPlaceholderPatientRow } from "../../shared/js-migrate/ensurePlaceholderPatientInfo.mjs";

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
  return String(v)
    .replace(/^\uFEFF/, "")
    .trim();
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
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d))
    return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * ทำความสะอาด height/weight จาก legacy MSSQL ก่อน parse
 * - "58." / "152." → ตัดจุดท้ายที่ไม่มีทศนิยม
 * - "151, 5" / "151,5" → จุลภาคทศนิยมแบบยุโรป
 */
function normalizeRealString(s) {
  let t = String(s).trim();
  if (t === "") return "";
  t = t.replace(/\s+/g, "");
  t = t.replace(/^\+/, "");
  t = t.replace(/(?<=\d)[+-]$/, "");
  if (/^-?\d+,\d+$/.test(t)) {
    t = t.replace(",", ".");
  }
  if (/^-?\d+\.$/.test(t)) {
    t = t.slice(0, -1);
  }
  return t;
}

function parseReal(s) {
  if (s == null) return null;
  const t = normalizeRealString(s);
  if (t === "" || !NUM_RE.test(t)) return null;
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n : null;
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
  if (digits !== "") return digits;
  return t;
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
  const parts = t
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p !== "");
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

function sourceRawNonempty(v) {
  if (v == null) return false;
  return (
    String(v)
      .replace(/^\uFEFF/, "")
      .trim() !== ""
  );
}

function sortPids(ids) {
  return [...ids].sort((a, b) => {
    try {
      const aa = BigInt(a);
      const bb = BigInt(b);
      return aa < bb ? -1 : aa > bb ? 1 : 0;
    } catch {
      return String(a).localeCompare(String(b));
    }
  });
}

function issueTextTruncated(pgField, srcRaw, mapped) {
  const src = nullIfTrimEmpty(srcRaw);
  if (src == null || src.length <= 255) return null;
  return {
    field: pgField,
    reason: "text_truncated",
    message: "ข้อความยาวกว่า 255 ตัวอักษร ถูกตัดก่อน insert",
    source_raw: srcRaw,
    mapped,
  };
}

/** แมปแถว MSSQL → ค่าที่จะ insert (ใช้ทั้ง insert และตรวจ field issues) */
function mapPatientInfoRow(row) {
  const np = normPid(getField(row, "pid"));
  const { phone_biz, phone_home } = normalizeAndDistributePhones(
    getField(row, "phone_biz"),
    getField(row, "phone_home"),
  );
  const h = parseReal(getField(row, "height"));
  const w = parseReal(getField(row, "weight"));

  return {
    pid: np,
    pid_raw: String(getField(row, "pid") ?? ""),
    patient: {
      old_db_id: np,
      pid: np,
      prefix_th: clampText255(getField(row, "prefix")),
      first_name_th: clampText255(getField(row, "name")),
      last_name_th: clampText255(getField(row, "surname")),
      date_of_birth: parseDateOfBirthGregorian(
        getField(row, "date_of_birth_be"),
      ),
      marital_status: clampText255(getField(row, "single")),
      phone_biz: clampText255(phone_biz),
      phone_home: clampText255(phone_home),
      height: h == null || Number.isNaN(h) ? null : h,
      weight: w == null || Number.isNaN(w) ? null : w,
      donate_type: parseDonateTypeInt(getField(row, "donate_type")),
      prefix_en: clampText255(getField(row, "eng_prefix")),
      first_name_en: clampText255(getField(row, "eng_name")),
      last_name_en: clampText255(getField(row, "eng_surname")),
      soc_id: clampText255(normSocId(getField(row, "soc_id"))),
      hn: clampText255(getField(row, "hn")),
      gender: clampText255(getField(row, "gender")),
      short_note: nullIfTrimEmpty(getField(row, "short_note")),
      disease: clampText255(getField(row, "disease")),
      mobile_phone: clampText255(getField(row, "mobile_phone")),
      email: clampText255(getField(row, "email")),
    },
    address: hasAddressPayload(row)
      ? {
          address: clampText255(getField(row, "address")),
          sub_district: clampText255(getField(row, "sub_area")),
          district: clampText255(getField(row, "area")),
          province: clampText255(getField(row, "province")),
          zipcode: clampText255(getField(row, "zip")),
          address2: clampText255(getField(row, "address2")),
        }
      : null,
  };
}

/**
 * @returns {{ field: string, reason: string, message: string, source_raw: unknown, mapped: unknown }[]}
 */
function collectPatientInfoFieldIssues(row, mapped) {
  const issues = [];
  const p = mapped.patient;

  if (mapped.pid === "" && sourceRawNonempty(getField(row, "pid"))) {
    issues.push({
      field: "pid",
      reason: "invalid_pid",
      message: "pid ในแหล่งข้อมูลว่างหรือใช้ migrate ไม่ได้",
      source_raw: getField(row, "pid"),
      mapped: null,
    });
    return issues;
  }

  const dobRaw = getField(row, "date_of_birth_be");
  if (sourceRawNonempty(dobRaw) && p.date_of_birth == null) {
    issues.push({
      field: "date_of_birth",
      reason: "date_parse_failed",
      message: "วันเกิดในแหล่งข้อมูลแปลงเป็น YYYY-MM-DD ไม่ได้",
      source_raw: dobRaw,
      mapped: null,
    });
  }

  const heightRaw = getField(row, "height");
  if (sourceRawNonempty(heightRaw) && p.height == null) {
    issues.push({
      field: "height",
      reason: "real_parse_failed",
      message: "ค่าส่วนสูงในแหล่งข้อมูลไม่ใช่ตัวเลขที่ถูกต้อง",
      source_raw: heightRaw,
      mapped: null,
    });
  }

  const weightRaw = getField(row, "weight");
  if (sourceRawNonempty(weightRaw) && p.weight == null) {
    issues.push({
      field: "weight",
      reason: "real_parse_failed",
      message: "ค่าน้ำหนักในแหล่งข้อมูลไม่ใช่ตัวเลขที่ถูกต้อง",
      source_raw: weightRaw,
      mapped: null,
    });
  }

  const donateRaw = getField(row, "donate_type");
  if (sourceRawNonempty(donateRaw) && p.donate_type == null) {
    issues.push({
      field: "donate_type",
      reason: "integer_parse_failed",
      message: "donate_type ในแหล่งข้อมูลไม่ใช่จำนวนเต็มที่ถูกต้อง",
      source_raw: donateRaw,
      mapped: null,
    });
  }

  const socRaw = getField(row, "soc_id");
  if (sourceRawNonempty(socRaw) && p.soc_id == null) {
    issues.push({
      field: "soc_id",
      reason: "soc_id_normalize_failed",
      message: "เลขบัตรประชาชนในแหล่งข้อมูลไม่มีตัวเลขที่ใช้ได้",
      source_raw: socRaw,
      mapped: null,
    });
  }

  const textChecks = [
    ["prefix_th", "prefix", p.prefix_th],
    ["first_name_th", "name", p.first_name_th],
    ["last_name_th", "surname", p.last_name_th],
    ["marital_status", "single", p.marital_status],
    ["phone_biz", "phone_biz", p.phone_biz],
    ["phone_home", "phone_home", p.phone_home],
    ["prefix_en", "eng_prefix", p.prefix_en],
    ["first_name_en", "eng_name", p.first_name_en],
    ["last_name_en", "eng_surname", p.last_name_en],
    ["hn", "hn", p.hn],
    ["gender", "gender", p.gender],
    ["disease", "disease", p.disease],
    ["mobile_phone", "mobile_phone", p.mobile_phone],
    ["email", "email", p.email],
  ];
  for (const [pgField, srcKey, mappedVal] of textChecks) {
    const iss = issueTextTruncated(pgField, getField(row, srcKey), mappedVal);
    if (iss) issues.push(iss);
  }

  if (mapped.address) {
    const addrChecks = [
      ["address.address", "address", mapped.address.address],
      ["address.sub_district", "sub_area", mapped.address.sub_district],
      ["address.district", "area", mapped.address.district],
      ["address.province", "province", mapped.address.province],
      ["address.zipcode", "zip", mapped.address.zipcode],
      ["address.address2", "address2", mapped.address.address2],
    ];
    for (const [pgField, srcKey, mappedVal] of addrChecks) {
      const iss = issueTextTruncated(pgField, getField(row, srcKey), mappedVal);
      if (iss) issues.push(iss);
    }
  }

  return issues;
}

/**
 * @returns {Map<string, { id: number, isPlaceholder: boolean }>}
 */
async function loadExistingPatientMetaByNpid(pgClient, npids) {
  if (npids.length === 0) return new Map();
  const { rows } = await pgClient.query(
    `
    SELECT id, migrate_stg.norm_pid(pid::text) AS npid, first_name_th
    FROM public.patient_info
    WHERE migrate_stg.norm_pid(pid::text) = ANY($1::text[])
    `,
    [npids],
  );
  /** @type {Map<string, { id: number, isPlaceholder: boolean }>} */
  const map = new Map();
  for (const row of rows) {
    if (!row.npid) continue;
    const meta = {
      id: row.id,
      isPlaceholder: isPlaceholderPatientRow(row),
    };
    const prev = map.get(row.npid);
    if (prev == null) {
      map.set(row.npid, meta);
      continue;
    }
    // ถ้ามีทั้ง placeholder และแถวจริง ให้ prefer แถวจริงสำหรับการตัดสิน insert-only
    if (prev.isPlaceholder && !meta.isPlaceholder) {
      map.set(row.npid, meta);
    } else if (!prev.isPlaceholder && meta.isPlaceholder) {
      continue;
    } else if (row.id < prev.id) {
      map.set(row.npid, meta);
    }
  }
  return map;
}

/** @param {{ mapped: ReturnType<typeof mapPatientInfoRow> }[]} payloads */
function buildPatientBulkArrays(payloads) {
  const aId = [];
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

  for (const { mapped, patientInfoId } of payloads) {
    const p = mapped.patient;
    if (patientInfoId != null) aId.push(patientInfoId);
    aOld.push(p.old_db_id);
    aPid.push(p.pid);
    aPreTh.push(p.prefix_th);
    aFnTh.push(p.first_name_th);
    aLnTh.push(p.last_name_th);
    aDob.push(p.date_of_birth);
    aMar.push(p.marital_status);
    aPhBiz.push(p.phone_biz);
    aPhHome.push(p.phone_home);
    aH.push(p.height);
    aW.push(p.weight);
    aDon.push(p.donate_type);
    aPreEn.push(p.prefix_en);
    aFnEn.push(p.first_name_en);
    aLnEn.push(p.last_name_en);
    aSoc.push(p.soc_id);
    aHn.push(p.hn);
    aGen.push(p.gender);
    aNote.push(p.short_note);
    aDis.push(p.disease);
    aMobile.push(p.mobile_phone);
    aEmail.push(p.email);
  }

  return {
    aId,
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
    aEmail,
  };
}

async function bulkInsertPatients(pgClient, arrays) {
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
      arrays.aOld,
      arrays.aPid,
      arrays.aPreTh,
      arrays.aFnTh,
      arrays.aLnTh,
      arrays.aDob,
      arrays.aMar,
      arrays.aPhBiz,
      arrays.aPhHome,
      arrays.aH,
      arrays.aW,
      arrays.aDon,
      arrays.aPreEn,
      arrays.aFnEn,
      arrays.aLnEn,
      arrays.aSoc,
      arrays.aHn,
      arrays.aGen,
      arrays.aNote,
      arrays.aDis,
      arrays.aMobile,
      arrays.aEmail,
    ],
  );
  return ins;
}

async function bulkUpdatePatientsById(pgClient, arrays) {
  const upd = await pgClient.query(
    `
    UPDATE public.patient_info AS p
    SET
      old_db_id = v.old_db_id,
      pid = v.pid,
      prefix_th = v.prefix_th,
      first_name_th = v.first_name_th,
      last_name_th = v.last_name_th,
      date_of_birth = v.date_of_birth,
      marital_status = v.marital_status,
      phone_biz = v.phone_biz,
      phone_home = v.phone_home,
      height = v.height,
      weight = v.weight,
      donate_type = v.donate_type,
      prefix_en = v.prefix_en,
      first_name_en = v.first_name_en,
      last_name_en = v.last_name_en,
      soc_id = v.soc_id,
      hn = v.hn,
      gender = v.gender,
      short_note = v.short_note,
      disease = v.disease,
      mobile_phone = v.mobile_phone,
      email = v.email
    FROM (
      SELECT * FROM unnest(
        $1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::date[],
        $8::text[], $9::text[], $10::text[], $11::float4[], $12::float4[], $13::int[],
        $14::text[], $15::text[], $16::text[], $17::text[], $18::text[], $19::text[],
        $20::text[], $21::text[], $22::text[], $23::text[]
      ) AS v(
        id, old_db_id, pid, prefix_th, first_name_th, last_name_th, date_of_birth, marital_status,
        phone_biz, phone_home, height, weight, donate_type, prefix_en, first_name_en, last_name_en,
        soc_id, hn, gender, short_note, disease, mobile_phone, email
      )
    ) v
    WHERE p.id = v.id
    `,
    [
      arrays.aId,
      arrays.aOld,
      arrays.aPid,
      arrays.aPreTh,
      arrays.aFnTh,
      arrays.aLnTh,
      arrays.aDob,
      arrays.aMar,
      arrays.aPhBiz,
      arrays.aPhHome,
      arrays.aH,
      arrays.aW,
      arrays.aDon,
      arrays.aPreEn,
      arrays.aFnEn,
      arrays.aLnEn,
      arrays.aSoc,
      arrays.aHn,
      arrays.aGen,
      arrays.aNote,
      arrays.aDis,
      arrays.aMobile,
      arrays.aEmail,
    ],
  );
  return upd.rowCount ?? arrays.aId.length;
}

async function deleteAddressesForPatientIds(pgClient, patientInfoIds) {
  if (patientInfoIds.length === 0) return;
  await pgClient.query(
    `DELETE FROM public.address WHERE patient_info = ANY($1::int[])`,
    [patientInfoIds],
  );
}

/**
 * @param {import("pg").PoolClient} pgClient
 * @param {{ row: object, mapped: ReturnType<typeof mapPatientInfoRow> }[]} items
 * @param {Map<string, number>} idByNpid
 */
async function insertAddressesForItems(pgClient, items, idByNpid) {
  const adAddr = [];
  const adSub = [];
  const adDist = [];
  const adProv = [];
  const adZip = [];
  const ad2 = [];
  const adPat = [];

  for (const { row, mapped } of items) {
    if (!hasAddressPayload(row)) continue;
    const np = mapped.pid;
    if (np === "") continue;
    const id = idByNpid.get(np);
    if (id == null) continue;
    const addr = mapped.address;
    adAddr.push(addr?.address ?? null);
    adSub.push(addr?.sub_district ?? null);
    adDist.push(addr?.district ?? null);
    adProv.push(addr?.province ?? null);
    adZip.push(addr?.zipcode ?? null);
    ad2.push(addr?.address2 ?? null);
    adPat.push(id);
  }

  if (adPat.length === 0) return 0;

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
    [st, adAddr, adSub, adDist, adProv, adZip, ad2, adPat, fromOld],
  );

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

  return insAddress.rowCount ?? adPat.length;
}

/**
 * แมป chunk → patient_info + address
 * - insert-only (resume): เพิ่มเฉพาะ PID ใหม่ ไม่แตะแถวจริงเดิม
 *   (แถว placeholder "ไม่ทราบชื่อ" จากตารางอื่นยังคงไว้ — INSERT แถว MSSQL เพิ่มได้)
 * - overwrite: UPDATE แถวเดิมตาม id + INSERT PID ใหม่ (ที่อยู่ลบแล้วใส่ใหม่)
 *
 * @param {import("pg").PoolClient} pgClient
 * @param {object[]} mssqlRows
 * @param {object} [options]
 * @param {'insert-only'|'overwrite'} [options.migrateRowMode]
 */
export async function runPatientInfoChunkPostLoad(
  pgClient,
  mssqlRows,
  options = {},
) {
  const rows = distinctOnNormPid(mssqlRows);
  if (rows.length === 0) {
    return { failedPids: [], fieldIssues: null };
  }

  const migrateRowMode = options.migrateRowMode ?? "overwrite";
  const insertOnly = migrateRowMode === "insert-only";

  const failingPidSet = new Set();
  let totalFieldIssueCount = 0;
  /** @type {Map<string, { pid: string, pid_raw: string, patient_info_id: number|null, fieldIssues: object[] }>} */
  const recordsWithIssues = new Map();

  function recordPidIssues(pid, meta, fieldIssues) {
    if (fieldIssues.length === 0) return;
    failingPidSet.add(pid);
    totalFieldIssueCount += fieldIssues.length;
    let rec = recordsWithIssues.get(pid);
    if (!rec) {
      rec = {
        pid,
        pid_raw: meta.pidRaw,
        patient_info_id: meta.patientInfoId ?? null,
        fieldIssues: [],
      };
      recordsWithIssues.set(pid, rec);
    }
    if (meta.patientInfoId != null) rec.patient_info_id = meta.patientInfoId;
    rec.fieldIssues.push(...fieldIssues);
  }

  /** @type {{ row: object, mapped: ReturnType<typeof mapPatientInfoRow>, patientInfoId?: number }[]} */
  const mappedItems = [];

  for (const r of rows) {
    const mapped = mapPatientInfoRow(r);
    const np = mapped.pid;
    if (np === "") {
      const issues = collectPatientInfoFieldIssues(r, mapped);
      if (issues.length > 0) {
        const rawPid = String(getField(r, "pid") ?? "").trim() || "(empty)";
        recordPidIssues(
          rawPid,
          { pidRaw: mapped.pid_raw, patientInfoId: null },
          issues,
        );
      }
      continue;
    }
    mappedItems.push({ row: r, mapped });
    recordPidIssues(
      np,
      { pidRaw: mapped.pid_raw, patientInfoId: null },
      collectPatientInfoFieldIssues(r, mapped),
    );
  }

  const npids = mappedItems.map((x) => x.mapped.pid);
  const existingMetaByNpid = await loadExistingPatientMetaByNpid(
    pgClient,
    npids,
  );

  /** @type {{ row: object, mapped: ReturnType<typeof mapPatientInfoRow>, patientInfoId?: number }[]} */
  const toInsert = [];
  /** @type {{ row: object, mapped: ReturnType<typeof mapPatientInfoRow>, patientInfoId: number }[]} */
  const toUpdate = [];

  for (const item of mappedItems) {
    const np = item.mapped.pid;
    const existing = existingMetaByNpid.get(np);
    if (existing != null) {
      if (insertOnly) {
        if (!existing.isPlaceholder) continue;
        toInsert.push(item);
      } else {
        toUpdate.push({ ...item, patientInfoId: existing.id });
      }
    } else {
      toInsert.push(item);
    }
  }

  const idByNpid = new Map(
    [...existingMetaByNpid.entries()].map(([np, meta]) => [np, meta.id]),
  );
  let patientRowsInserted = 0;
  let patientRowsUpdated = 0;
  let addressRowsInserted = 0;

  if (toUpdate.length > 0) {
    const updArrays = buildPatientBulkArrays(toUpdate);
    patientRowsUpdated = await bulkUpdatePatientsById(pgClient, updArrays);
    for (const u of toUpdate) {
      const rec = recordsWithIssues.get(u.mapped.pid);
      if (rec) rec.patient_info_id = u.patientInfoId;
    }
    await deleteAddressesForPatientIds(
      pgClient,
      toUpdate.map((u) => u.patientInfoId),
    );
    addressRowsInserted += await insertAddressesForItems(
      pgClient,
      toUpdate,
      idByNpid,
    );
  }

  if (toInsert.length > 0) {
    await pgClient.query(`
      SELECT setval(
        pg_get_serial_sequence('public.patient_info', 'id'),
        COALESCE((SELECT MAX(id) + 1 FROM public.patient_info), 1),
        false
      );
    `);
    const insArrays = buildPatientBulkArrays(
      toInsert.map((x) => ({ mapped: x.mapped, patientInfoId: null })),
    );
    const ins = await bulkInsertPatients(pgClient, insArrays);
    for (const r of ins.rows) {
      idByNpid.set(normPid(r.pid), r.id);
    }
    patientRowsInserted = ins.rowCount ?? insArrays.aPid.length;

    for (const item of toInsert) {
      const id = idByNpid.get(item.mapped.pid);
      if (id != null) {
        const rec = recordsWithIssues.get(item.mapped.pid);
        if (rec) rec.patient_info_id = id;
      }
    }

    addressRowsInserted += await insertAddressesForItems(
      pgClient,
      toInsert,
      idByNpid,
    );
  }

  for (const np of npids) {
    const existing = existingMetaByNpid.get(np);
    if (insertOnly && existing != null && !existing.isPlaceholder) continue;
    if (!idByNpid.has(np)) {
      recordPidIssues(np, { pidRaw: np, patientInfoId: null }, [
        {
          field: "_record",
          reason: "insert_missing_after_migrate",
          message: "แมปแล้ว แต่ไม่พบแถวใน public.patient_info",
          source_raw: np,
          mapped: null,
        },
      ]);
    }
  }

  return buildChunkFieldIssueResult(
    patientRowsInserted,
    addressRowsInserted,
    patientRowsUpdated,
  );

  function buildChunkFieldIssueResult(patientInserted, addressInserted, patientUpdated) {
    const failedPids = sortPids(failingPidSet);
    const hasIssues = totalFieldIssueCount > 0;
    return {
      failedPids,
      fieldIssues: hasIssues
        ? {
            totalFieldIssueCount,
            rowsInserted: patientInserted,
            summaryExtras: {
              addressRowsInserted: addressInserted,
              patientRowsUpdated: patientUpdated,
            },
            records: [...recordsWithIssues.values()],
          }
        : null,
    };
  }
}
