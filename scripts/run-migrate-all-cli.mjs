/**
 * Cross-platform entry for npm run migrate:all
 * - Windows: powershell.exe
 * - Linux / macOS: pwsh (PowerShell 7+)
 *
 * Forward args after npm's -- to the script, e.g. npm run migrate:all -- -SkipInstall
 */
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const ps1 = join(repoRoot, "run-migrate-all.ps1");
const forwarded = process.argv.slice(2);

const common = [
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  ps1,
  ...forwarded,
];

function main() {
  if (process.platform === "win32") {
    const r = spawnSync("powershell.exe", common, {
      stdio: "inherit",
      cwd: repoRoot,
      env: process.env,
    });
    process.exit(r.status === null ? 1 : r.status);
  }

  const r = spawnSync("pwsh", common, {
    stdio: "inherit",
    cwd: repoRoot,
    env: process.env,
  });

  if (r.error?.code === "ENOENT") {
    console.error(
      [
        "pwsh not found. On Linux or macOS install PowerShell 7, then retry:",
        "  https://learn.microsoft.com/powershell/scripting/install/installing-powershell",
        "",
        "Or run each job from repo root without PowerShell, e.g.:",
        "  npm run migrate:patient_info && npm run migrate:appointment && ...",
      ].join("\n"),
    );
    process.exit(1);
  }

  process.exit(r.status === null ? 1 : r.status);
}

main();
