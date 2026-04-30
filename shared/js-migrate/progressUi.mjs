export function createUiState() {
  return { progressInline: false };
}

export function formatSec(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

export function renderProgress(
  current,
  total,
  startedAtMs,
  chunkCurrent = null,
  chunkTotal = null,
) {
  const width = 28;
  const elapsedSec = ((Date.now() - startedAtMs) / 1000).toFixed(1).padStart(6, " ");
  if (total == null || total <= 0) {
    process.stdout.write(
      `\r[${"#".repeat(width)}]  -----%  rows ${current}  elapsed ${elapsedSec}s  chunk ${chunkCurrent ?? "?"}/${chunkTotal ?? "?"}`,
    );
    return;
  }
  const ratio = Math.max(0, Math.min(1, current / total));
  const filled = Math.round(width * ratio);
  const bar = `${"#".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}`;
  const pct = (ratio * 100).toFixed(1).padStart(5, " ");
  process.stdout.write(
    `\r[${bar}] ${pct}%  rows ${current}/${total}  elapsed ${elapsedSec}s  chunk ${chunkCurrent ?? "?"}/${chunkTotal ?? "?"}`,
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
