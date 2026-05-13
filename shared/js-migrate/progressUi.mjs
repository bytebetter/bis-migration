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

function writeProgressLine(line, state) {
  const clipped =
    line.length > PROGRESS_LINE_WIDTH
      ? line.slice(0, PROGRESS_LINE_WIDTH)
      : line.padEnd(PROGRESS_LINE_WIDTH, " ");
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
