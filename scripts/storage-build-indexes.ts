// Build pending projection indexes, search indexes and unwinds now, instead
// of waiting for the background build after the next request. See
// src/lib/storage/builder.ts.
//
//   npm run storage:build-indexes -- [--collection <id|slug>] [--json]
//
// Without --collection, every collection with build work. Failed builds are
// retried right away (their backoff only applies to automatic retries).
// A collection another builder is working on is skipped. Exits 1 when a
// build failed.
//
// Env: HUTCH_DATABASE_URL (or DATABASE_URL); .env.local is read if present.
// HUTCH_INDEX_BUILD_TIMEOUT_MS bounds each build statement (default 10 min).

import { existsSync } from "node:fs";
import { config } from "dotenv";

const USAGE = "usage: npm run storage:build-indexes -- [--collection <id|slug>] [--json]";

function parseArgs(argv: string[]) {
  const opts: { collection?: string; json: boolean } = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--collection" && argv[i + 1]) opts.collection = argv[++i];
    else if (arg === "--json") opts.json = true;
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (existsSync(".env.local")) config({ path: ".env.local", quiet: true });
  if (!process.env.HUTCH_DATABASE_URL && !process.env.DATABASE_URL) {
    console.error("HUTCH_DATABASE_URL is not set");
    process.exit(2);
  }

  const { sql } = await import("drizzle-orm");
  const { db, pool } = await import("../src/lib/db");
  const { buildPendingIndexes } = await import("../src/lib/storage/builder");

  try {
    let collectionId: number | undefined;
    if (opts.collection !== undefined) {
      const asId = /^[1-9][0-9]*$/.test(opts.collection) ? Number(opts.collection) : null;
      const rows = (await db.execute(sql`SELECT id FROM collections WHERE slug = ${opts.collection} OR id = ${asId}`)).rows as { id: number }[];
      if (rows.length !== 1) {
        console.error(`no collection with id or slug '${opts.collection}'`);
        process.exitCode = 2;
        return;
      }
      collectionId = rows[0].id;
    }
    const report = await buildPendingIndexes({ collectionId, retryFailed: true, log: (line) => console.log(line) });
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    const outcomes = report.collections.flatMap((c) => c.outcomes);
    const skipped = report.collections.filter((c) => c.skipped).map((c) => c.collectionId);
    console.log(`done: ${outcomes.filter((o) => o.state === "ready").length} built, ${report.failed} failed${skipped.length ? `, skipped (another builder holds them): ${skipped.join(", ")}` : ""}`);
    if (report.failed > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
