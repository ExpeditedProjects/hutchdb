// Move an existing database from the old shared `records` table into
// per-collection tables. See src/lib/storage/cutover.ts for what each step
// does and how it verifies.
//
//   npm run storage:cutover -- [--dry-run] [--drop-records] [--dump-dir <dir>] [--json]
//
// Takes a pg_dump of the whole database first and refuses to go on if that
// fails. --dry-run copies and verifies every collection inside a transaction
// and rolls it back (no dump, no inference, no drop). --drop-records drops
// `records` after every collection has been copied and verified; without it
// the old table is left in place. Re-running skips finished collections.
//
// After inference it builds the queued indexes and unwinds (the background
// builder, src/lib/storage/builder.ts) before exiting.
//
// Env: HUTCH_DATABASE_URL (or DATABASE_URL); .env.local is read if present.
// HUTCH_INDEX_BUILD_TIMEOUT_MS bounds each index build (default 10 min).
// Run it in a quiet minute: there is no write lock.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "dotenv";
import { splitPassword } from "../src/lib/storage/pg-url";

const USAGE = "usage: npm run storage:cutover -- [--dry-run] [--drop-records] [--dump-dir <dir>] [--json]";

function parseArgs(argv: string[]) {
  const opts = { dryRun: false, dropRecords: false, json: false, dumpDir: "storage-cutover-backups" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--drop-records") opts.dropRecords = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--dump-dir" && argv[i + 1]) opts.dumpDir = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`unknown argument '${arg}'\n${USAGE}`);
      process.exit(2);
    }
  }
  return opts;
}

/** pg_dump the whole database (custom format) and return the file path, or exit. */
function dumpDatabase(url: string, dir: string): string {
  // The dump holds every secret in the database: owner-only directory and
  // file, whatever the caller's umask, and even if the directory existed.
  process.umask(0o077);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = resolve(join(dir, `hutch-before-cutover-${stamp}.dump`));
  console.log(`pg_dump -> ${file}`);
  const { url: safeUrl, password } = splitPassword(url);
  const env = { ...process.env, ...(password !== undefined ? { PGPASSWORD: password } : {}) };
  const result = spawnSync("pg_dump", ["--format=custom", "--no-owner", "--file", file, safeUrl], { stdio: ["ignore", "inherit", "inherit"], env });
  if (result.error || result.status !== 0 || !existsSync(file) || statSync(file).size === 0) {
    console.error(`pg_dump failed (${result.error?.message ?? `exit ${result.status}`}); refusing to run the cutover.`);
    process.exit(1);
  }
  chmodSync(file, 0o600);
  console.log(`pg_dump ok: ${file} (${statSync(file).size} bytes)`);
  return file;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (existsSync(".env.local")) config({ path: ".env.local", quiet: true });
  const url = process.env.HUTCH_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error("HUTCH_DATABASE_URL is not set");
    process.exit(2);
  }
  // The copy runs in one long transaction; lift the request timeout.
  process.env.HUTCH_DB_STATEMENT_TIMEOUT_MS ??= "0";

  const { recordsTableExists, runCutover, CutoverError } = await import("../src/lib/storage/cutover");
  const { pool } = await import("../src/lib/db");

  try {
    let dump: string | null = null;
    if (opts.dryRun) {
      console.log("dry run: no pg_dump, nothing is kept");
    } else if (await recordsTableExists()) {
      dump = dumpDatabase(url, opts.dumpDir);
    }
    const report = await runCutover({ dryRun: opts.dryRun, dropRecords: opts.dropRecords, log: (line) => console.log(line) });
    if (opts.json) console.log(JSON.stringify({ dump, ...report }, null, 2));
    const warnings = report.copied.flatMap((c) => c.warnings.map((w) => `${c.slug}: ${w}`));
    const failed = report.inference.filter((r) => r.error);
    const failedBuilds = report.builds.filter((b) => b.state === "failed");
    console.log(`done: ${report.copied.filter((c) => c.status === "copied").length} copied, ${report.copied.filter((c) => c.status === "already done").length} already done, ${report.inference.length} inferred, ${report.builds.length - failedBuilds.length} indexes built${report.dropped ? ", records dropped" : ""}${dump ? `; backup ${dump}` : ""}`);
    for (const w of warnings) console.log(`warning: ${w}`);
    for (const r of failed) console.log(`inference failed: ${r.slug}: ${r.error}`);
    for (const b of failedBuilds) console.log(`build failed: ${b.slug}: ${b.kind} ${b.key}: ${b.error}`);
    if (failed.length > 0) {
      console.error(`rows copied and verified; inference failed for: ${failed.map((r) => r.slug).join(", ")}; re-run to retry`);
      process.exitCode = 1;
    }
    if (failedBuilds.length > 0) {
      console.error(`rows copied and verified; ${failedBuilds.length} index builds failed; re-run or \`npm run storage:build-indexes\` to retry`);
      process.exitCode = 1;
    }
    if (report.skipped_builds.length > 0) {
      console.error(`rows copied and verified; builds for ${report.skipped_builds.join(", ")} were skipped because another builder holds them and are still pending; run \`npm run storage:build-indexes\` once it is done`);
      process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof CutoverError) {
      console.error(`cutover stopped: ${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
