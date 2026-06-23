/**
 * ขนาด chunk ต่อรอบ migrate — จำกัด floor/cap เพื่อไม่ให้ memory/IN clause เกิน
 * @param {object} migrationConfig
 * @param {object} [tableJob]
 * @param {{ cap?: number, floor?: number, fallback?: number }} [opts]
 */
export function resolveBatchSize(migrationConfig, tableJob = {}, opts = {}) {
  const cap = opts.cap ?? 20000;
  const floor = opts.floor ?? 50;
  const fallback = opts.fallback ?? 2000;
  const raw = Number(
    tableJob.batchSize ?? migrationConfig?.batchSize ?? fallback,
  );
  const n = Number.isFinite(raw) ? raw : fallback;
  return Math.max(floor, Math.min(cap, n));
}
