export function createUiState() {
  return { progressInline: false };
}

export function formatSec(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function clearStdoutLinePrefix() {
  if (typeof process.stdout.isTTY === "boolean" && process.stdout.isTTY) {
    process.stdout.write("\x1b[2K\r");
    return;
  }
  process.stdout.write("\r");
}
export function renderProgress(
  current,
  total,
  startedAtMs,
  chunkCurrent = null,
  chunkTotal = null,
) {
  const width = 28;
  const elapsedSec = ((Date.now() - startedAtMs) / 1000)
    .toFixed(1)
    .padStart(6, " ");
  let eta = "";
  if (total != null && total > 0 && current > 0 && current <= total) {
    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs >= 500) {
      const left = Math.max(0, total - current);
      const etaSec = Math.round((left * elapsedMs) / current / 1000);
      if (Number.isFinite(etaSec))
        eta = ` ETA~${String(etaSec).padStart(5, " ")}s`;
    }
  }
  clearStdoutLinePrefix();
  if (total == null || total <= 0) {
    process.stdout.write(
      `[${"#".repeat(width)}]  -----%  rows ${current}${eta}  elapsed ${elapsedSec}s  chunk ${chunkCurrent ?? "?"}/${chunkTotal ?? "?"}`,
    );
    return;
  }
  const ratio = Math.max(0, Math.min(1, current / total));
  const filled = Math.round(width * ratio);
  const bar = `${"#".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}`;
  const pct = (ratio * 100).toFixed(1).padStart(5, " ");
  process.stdout.write(
    `[${bar}] ${pct}%  rows ${current}/${total}${eta}  elapsed ${elapsedSec}s  chunk ${chunkCurrent ?? "?"}/${chunkTotal ?? "?"}`,
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
