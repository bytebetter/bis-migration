/** คีย์เทียบ fullname ตรงๆ (trim + ตัด BOM เท่านั้น) */
export function referringMdMatchKey(v) {
  if (v == null) return "";
  return String(v)
    .replace(/^\uFEFF/, "")
    .trim();
}

function clampFullname255(v) {
  const t = referringMdMatchKey(v);
  if (t === "") return null;
  return t.length <= 255 ? t : t.slice(0, 255);
}

/**
 * โหลด/สร้าง public.referring_md ตาม fullname ตรงตัว
 * @returns {Promise<Map<string, number>>} matchKey → id
 */
export async function ensureReferringMdByFullnames(pgClient, rawNames) {
  const names = [
    ...new Set(
      (rawNames ?? [])
        .map((n) => referringMdMatchKey(n))
        .filter((n) => n !== ""),
    ),
  ];
  /** @type {Map<string, number>} */
  const idByKey = new Map();
  if (names.length === 0) return idByKey;

  const { rows: found } = await pgClient.query(
    `
    SELECT id, btrim(fullname::text) AS k
    FROM public.referring_md
    WHERE fullname IS NOT NULL
      AND btrim(fullname::text) = ANY($1::text[])
    `,
    [names],
  );
  for (const r of found) {
    const k = r.k == null ? "" : String(r.k);
    if (k !== "" && !idByKey.has(k)) idByKey.set(k, Number(r.id));
  }

  const missing = names.filter((n) => !idByKey.has(n));
  if (missing.length === 0) return idByKey;

  const aFn = missing.map((n) => clampFullname255(n));
  const ins = await pgClient.query(
    `
    INSERT INTO public.referring_md (fullname)
    SELECT * FROM unnest($1::text[]) AS t(fullname)
    RETURNING id, btrim(fullname::text) AS k
    `,
    [aFn],
  );
  for (const r of ins.rows) {
    const k = r.k == null ? "" : String(r.k);
    if (k !== "") idByKey.set(k, Number(r.id));
  }

  await pgClient.query(`
    SELECT setval(
      pg_get_serial_sequence('public.referring_md', 'id'),
      COALESCE((SELECT MAX(id) + 1 FROM public.referring_md), 1),
      false
    )
    WHERE pg_get_serial_sequence('public.referring_md', 'id') IS NOT NULL
  `);

  return idByKey;
}
