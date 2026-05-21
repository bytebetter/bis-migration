/**
 * Cross-platform entry for npm run migrate:all
 * - Windows: powershell.exe
 * - Linux / macOS: pwsh (PowerShell 7+)
 *
 * Forward args after npm's -- to run-migrate-all.ps1.
 * npm บน Windows มักกลืน -MigrateRunMode เหลือแค่ overwrite — แปลงให้เป็น -MigrateRunMode overwrite
 *
 * Examples:
 *   npm run migrate:all -- -MigrateRunMode overwrite -SkipInstall
 *   npm run migrate:all -- --migrate-run-mode overwrite
 *   npm run migrate:all -- overwrite
 */
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const ps1 = join(repoRoot, "run-migrate-all.ps1");

const RUN_MODES = new Set(["resume", "overwrite", "repair-from-log", "full"]);
const RUN_MODE_FLAGS = new Set([
  "-migraterunmode",
  "--migrate-run-mode",
  "-migraterunmode:",
]);

/**
 * @param {string[]} argv process.argv.slice(2)
 * @returns {string[]} args สำหรับ powershell -File run-migrate-all.ps1
 */
export function normalizeMigrateAllPsArgs(argv) {
  /** @type {string[]} */
  const out = [];
  let migrateRunMode = "";
  let migrateMode = "";
  let skipInstall = false;

  const pushRest = (token) => {
    if (token != null && String(token).trim() !== "") out.push(String(token));
  };

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const a = String(raw).trim();
    const low = a.toLowerCase();

    if (RUN_MODE_FLAGS.has(low) || low.startsWith("-migraterunmode:")) {
      const inline = a.includes(":") ? a.split(":").slice(1).join(":").trim() : "";
      const next = argv[i + 1];
      const val = inline || (next != null && !String(next).startsWith("-") ? String(next).trim() : "");
      if (!inline && next != null && !String(next).startsWith("-")) i++;
      if (val && RUN_MODES.has(val.toLowerCase())) migrateRunMode = val.toLowerCase();
      continue;
    }

    if (low === "-migratemode" || low === "--migrate-mode") {
      const next = argv[i + 1];
      if (next != null && !String(next).startsWith("-")) {
        migrateMode = String(next).trim().toLowerCase();
        i++;
      }
      continue;
    }

    if (low === "-skipinstall" || low === "--skip-install") {
      skipInstall = true;
      continue;
    }

    if (RUN_MODES.has(low)) {
      migrateRunMode = low;
      continue;
    }

    pushRest(a);
  }

  /** @type {string[]} */
  const ps = [];
  if (migrateRunMode) ps.push("-MigrateRunMode", migrateRunMode);
  if (migrateMode) ps.push("-MigrateMode", migrateMode);
  if (skipInstall) ps.push("-SkipInstall");
  ps.push(...out);
  return ps;
}

function main() {
  const forwarded = normalizeMigrateAllPsArgs(process.argv.slice(2));

  const common = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    ps1,
    ...forwarded,
  ];

  if (process.env.DEBUG_MIGRATE_ALL_CLI === "1") {
    console.error("[migrate:all] powershell args:", common.join(" "));
  }

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
