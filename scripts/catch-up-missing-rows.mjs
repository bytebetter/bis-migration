/**
 * เก็บตกแถวที่ต้นทางมีแต่ Postgres ไม่มี (อธิบายเหตุผลไว้ใน scripts/catchUpMissingRows.mjs)
 *
 * migrate:all (resume) เรียกให้เอง 2 ครั้งต่อตาราง:
 *   --snapshot-keys <file>   ตอน snapshot count: อ่าน key ต้นทาง (NOLOCK) เขียนลงไฟล์
 *   --keys <file>            หลังตารางนั้น migrate เสร็จ: เทียบกับ Postgres แล้ว migrate เฉพาะที่ขาด
 *
 * รันเองเพื่อตรวจ (อ่านต้นทางสด ณ ตอนนี้ ไม่แก้ข้อมูล):
 *   node scripts/catch-up-missing-rows.mjs --config ./migration.config.local.json --profile examination --dry-run
 *
 * ตัวเลือก: --result <json> (สรุปผลให้ migrate:all เขียน log), --max-ids <n> ต่อรอบ (20000),
 *           --chunk <n> id ต่อการเรียก migrate 1 ครั้ง (2000)
 * exit 1 เมื่อเรียก migrate ของตารางแล้วล้มเหลว หรือต่อฐานข้อมูลไม่ได้
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import pg from "pg";
import {
  bracketMssqlIdent,
  buildMssqlConfig,
} from "../shared/js-migrate/mssqlConnectConfig.mjs";
import {
  resolveMssqlSourceObject,
  resolveRuntimeConfig,
} from "../shared/js-migrate/resolveMigrationConfig.mjs";
import {
  CATCH_UP_SPECS,
  childEnvWithoutNpm,
  chunkSourceIds,
  computeCatchUpPlan,
  formatKeyLine,
  pgUnitsOf,
  readKeyFile,
} from "./catchUpMissingRows.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function positiveInt(raw, fallback) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const fmt = (n) => Number(n).toLocaleString("en-US");

/** อ่าน key ต้นทางแบบ stream (ตารางใหญ่หลักล้านแถว) */
function streamSourceUnits(pool, sqlText, spec, onUnit) {
  return new Promise((resolve, reject) => {
    const req = pool.request();
    req.stream = true;
    let n = 0;
    let failed = null;
    req.on("row", (r) => {
      const u = spec.toSourceUnit(r);
      if (u) {
        n++;
        onUnit(u);
      }
    });
    req.on("error", (err) => {
      failed ??= err;
    });
    req.on("done", () => (failed ? reject(failed) : resolve(n)));
    req.query(sqlText);
  });
}

async function writeSourceKeyFile(pool, srcObj, spec, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const ws = fs.createWriteStream(tmp, { encoding: "utf8" });
  let buf = [];
  const n = await streamSourceUnits(pool, spec.sourceKeysSql(srcObj), spec, (u) => {
    buf.push(formatKeyLine(u));
    if (buf.length >= 10000) {
      ws.write(buf.join(""));
      buf = [];
    }
  });
  if (buf.length > 0) ws.write(buf.join(""));
  await new Promise((resolve, reject) => {
    ws.on("error", reject);
    ws.end(resolve);
  });
  // เขียนเสร็จทั้งไฟล์ค่อยแทนที่ — ไฟล์ครึ่งๆ จะไม่ถูกเอาไปใช้
  fs.renameSync(tmp, file);
  return n;
}

async function loadSourceUnits(pool, srcObj, spec, keysFile) {
  const units = [];
  if (keysFile) {
    for await (const u of readKeyFile(keysFile)) units.push(u);
    return units;
  }
  await streamSourceUnits(pool, spec.sourceKeysSql(srcObj), spec, (u) => units.push(u));
  return units;
}

/** คืน iterable (ไม่สร้าง array ชุดที่สอง — pacs_sync_info หลักล้านแถว) */
async function loadPgUnits(client, spec) {
  const res = await client.query({
    text: await spec.pgKeysSql(client),
    values: spec.pgParams ?? [],
    rowMode: "array",
  });
  return (function* units() {
    for (const row of res.rows) yield* pgUnitsOf(spec, row);
  })();
}

function runTableMigrate({ spec, profile, configPath, ids }) {
  const cwd = path.join(repoRoot, spec.dir, "js-migrate");
  const r = spawnSync(
    process.execPath,
    [
      path.join(cwd, "migrate-from-mssql.mjs"),
      "--config",
      configPath,
      "--profile",
      profile,
      "--source-ids",
      ids.join(","),
    ],
    { cwd, stdio: "inherit", env: childEnvWithoutNpm() },
  );
  if (r.error) throw r.error;
  return r.status ?? 1;
}

function writeResult(file, result) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

function logPlan(tag, plan, dryRun) {
  console.log(
    `${tag} ต้นทาง ${fmt(plan.sourceRows)} แถว, Postgres ${fmt(plan.pgRows)} แถว → ขาด ${fmt(plan.missingRows)} แถว (${fmt(plan.sends.length)} id ที่จะเติม)`,
  );
  if (plan.partialSends.length > 0) {
    console.log(
      `${tag} ข้าม ${fmt(plan.partialSends.length)} id ที่ Postgres มีบางแถวแล้ว (ไม่เขียนทับ): ${plan.partialSends.slice(0, 20).join(", ")}${plan.partialSends.length > 20 ? " ..." : ""}`,
    );
  }
  if (plan.unsendable.length > 0) {
    console.log(
      `${tag} ข้าม ${fmt(plan.unsendable.length)} id ที่มี , ; หรือช่องว่าง (ส่งผ่าน --source-ids ไม่ได้): ${plan.unsendable.slice(0, 20).join(" | ")}`,
    );
  }
  if (dryRun && plan.sends.length > 0) {
    console.log(
      `${tag} ตัวอย่าง id ที่ขาด: ${plan.sends.slice(0, 50).join(", ")}${plan.sends.length > 50 ? " ..." : ""}`,
    );
  }
}

async function main() {
  const profile = String(argValue("--profile") ?? "").trim();
  const spec = CATCH_UP_SPECS[profile];
  if (!spec) {
    console.error(
      `--profile ต้องเป็นหนึ่งใน: ${Object.keys(CATCH_UP_SPECS).join(", ")}`,
    );
    process.exit(2);
  }
  const configPath = path.resolve(
    argValue("--config") ?? path.join(repoRoot, "migration.config.local.json"),
  );
  const snapshotFile = argValue("--snapshot-keys");
  const keysFile = argValue("--keys");
  const resultFile = argValue("--result");
  const dryRun = process.argv.includes("--dry-run");
  const maxIds = positiveInt(argValue("--max-ids"), 20000);
  const chunkSize = positiveInt(argValue("--chunk"), 2000);
  const tag = `>>> [catch-up:${profile}]`;

  const config = resolveRuntimeConfig(
    JSON.parse(fs.readFileSync(configPath, "utf8")),
    profile,
  );
  const { schema, table } = resolveMssqlSourceObject(profile, config.source);
  const srcObj = `${bracketMssqlIdent(schema)}.${bracketMssqlIdent(table)} WITH (NOLOCK)`;

  const pool = await sql.connect(buildMssqlConfig(config.source));
  try {
    if (snapshotFile) {
      const n = await writeSourceKeyFile(pool, srcObj, spec, path.resolve(snapshotFile));
      console.log(`##CATCHUP_KEYS## ${n}`);
      return;
    }

    const result = { profile, ok: false, dryRun };
    const sourceUnits = await loadSourceUnits(
      pool,
      srcObj,
      spec,
      keysFile ? path.resolve(keysFile) : null,
    );
    const t = config.target;
    const client = new pg.Client({
      host: t.postgresHost,
      port: Number(t.postgresPort ?? 5432),
      user: t.postgresUser,
      password: t.postgresPassword,
      database: t.postgresDatabase,
    });
    await client.connect();
    try {
      const plan = computeCatchUpPlan(sourceUnits, await loadPgUnits(client, spec), {
        multiset: spec.multiset,
      });
      logPlan(tag, plan, dryRun);
      const toSend = plan.sends.slice(0, maxIds);
      Object.assign(result, {
        sourceRows: plan.sourceRows,
        pgRows: plan.pgRows,
        missingRows: plan.missingRows,
        partial: plan.partialSends.length,
        unsendable: plan.unsendable.length,
        deferred: plan.sends.length - toSend.length,
        attempted: 0,
        remaining: 0,
      });
      if (result.deferred > 0) {
        console.log(
          `${tag} เกินเพดาน ${fmt(maxIds)} id ต่อรอบ — เติม ${fmt(toSend.length)} id ก่อน ที่เหลือ ${fmt(result.deferred)} id รอรอบถัดไป`,
        );
      }
      if (dryRun || toSend.length === 0) {
        result.ok = true;
        writeResult(resultFile, result);
        return;
      }

      for (const ids of chunkSourceIds(toSend, chunkSize)) {
        console.log(`${tag} migrate ${fmt(ids.length)} id ผ่าน --source-ids`);
        const status = runTableMigrate({ spec, profile, configPath, ids });
        if (status !== 0) {
          result.error = `migrate ${profile} --source-ids exit ${status}`;
          writeResult(resultFile, result);
          console.error(`${tag} ${result.error}`);
          process.exitCode = 1;
          return;
        }
        result.attempted += ids.length;
      }

      // ตรวจซ้ำ: id ที่ส่งไปแล้วยังขาดอยู่ = map ไม่ผ่าน / ต้นทางลบไประหว่างนี้ (ดู field issue log ของตาราง)
      const after = computeCatchUpPlan(sourceUnits, await loadPgUnits(client, spec), {
        multiset: spec.multiset,
      });
      const sent = new Set(toSend);
      const stillMissing = [...after.sends, ...after.partialSends].filter((id) => sent.has(id));
      result.remaining = stillMissing.length;
      result.ok = true;
      const stillNote =
        stillMissing.length > 0
          ? ` — ยังขาด ${fmt(stillMissing.length)}: ${stillMissing.slice(0, 20).join(", ")}`
          : "";
      console.log(
        `${tag} เติมแล้ว ${fmt(result.attempted - stillMissing.length)}/${fmt(result.attempted)} id${stillNote}`,
      );
      writeResult(resultFile, result);
    } finally {
      await client.end();
    }
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error(">>> [catch-up] ล้มเหลว:", err instanceof Error ? err.message : err);
  process.exit(1);
});
