import {
  installMigrateLogFilter,
  shouldPrintMigrateLine,
} from "./migrateLogLevel.mjs";

// ทุก entry ของ migrate import ไฟล์นี้ — ติดตั้งตัวกรองข้อความครั้งเดียวตอนโหลด
const migrateLogLevel = installMigrateLogFilter();

const PROGRESS_LINE_WIDTH = 200;

export function createUiState() {
  return { progressInline: false };
}

export function formatSec(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatProgressLine(
  current,
  total,
  startedAtMs,
  chunkCurrent,
  chunkTotal,
) {
  const barWidth = 24;
  const elapsedSec = ((Date.now() - startedAtMs) / 1000)
    .toFixed(1)
    .padStart(6, " ");
  let eta = " ETA~  ----s";
  if (total != null && total > 0 && current > 0 && current <= total) {
    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs >= 500) {
      const left = Math.max(0, total - current);
      const etaSec = Math.round((left * elapsedMs) / current / 1000);
      if (Number.isFinite(etaSec)) {
        eta = ` ETA~${String(etaSec).padStart(5, " ")}s`;
      }
    }
  }
  const chunkLabel = `${chunkCurrent ?? "?"}/${chunkTotal ?? "?"}`;
  if (total == null || total <= 0) {
    const bar = "#".repeat(barWidth);
    return `[${bar}]  -----%  rows ${current}${eta}  elapsed ${elapsedSec}s  chunk ${chunkLabel}`;
  }
  const ratio = Math.max(0, Math.min(1, current / total));
  const filled = Math.round(barWidth * ratio);
  const bar = `${"#".repeat(filled)}${"-".repeat(Math.max(0, barWidth - filled))}`;
  const pct = (ratio * 100).toFixed(1).padStart(5, " ");
  return `[${bar}] ${pct}%  rows ${current}/${total}${eta}  elapsed ${elapsedSec}s  chunk ${chunkLabel}`;
}

/** ความกว้างสูงสุดของบรรทัด progress — ไม่เกินความกว้างจอ (ล้นจอ = ขึ้นบรรทัดใหม่ทุกครั้งที่อัปเดต) */
function progressLineWidth() {
  const cols = process.stdout.isTTY ? Number(process.stdout.columns) : 0;
  return cols > 1 ? Math.min(cols - 1, PROGRESS_LINE_WIDTH) : PROGRESS_LINE_WIDTH;
}

function writeProgressLine(line, state) {
  // ไม่เติมช่องว่าง: \x1b[2K ล้างบรรทัดเดิมให้แล้ว
  const width = progressLineWidth();
  const clipped = line.length > width ? line.slice(0, width) : line;
  if (state?.progressInline) {
    process.stdout.write(`\x1b[2K\r${clipped}`);
  } else {
    process.stdout.write(clipped);
  }
  if (state) state.progressInline = true;
}

export function renderProgress(
  current,
  total,
  startedAtMs,
  chunkCurrent = null,
  chunkTotal = null,
  state = null,
) {
  writeProgressLine(
    formatProgressLine(
      current,
      total,
      startedAtMs,
      chunkCurrent,
      chunkTotal,
    ),
    state,
  );
}

export function writeOutLine(msg, state) {
  if (!shouldPrintMigrateLine(msg, migrateLogLevel)) return;
  if (state?.progressInline) {
    process.stdout.write("\n");
    state.progressInline = false;
  }
  process.stdout.write(`${msg}\n`);
}

export function markProgressInline(state) {
  if (state) state.progressInline = true;
}

export function endProgress(state) {
  if (state?.progressInline) {
    process.stdout.write("\n");
    state.progressInline = false;
  }
}
