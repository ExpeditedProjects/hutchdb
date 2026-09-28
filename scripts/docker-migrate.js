// Runs on every container start. Pure pg + fs so it works from the Next.js
// standalone image, which traces drizzle-orm into compiled server code but
// doesn't preserve it as a require-able module.

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const MIGRATIONS_DIR = path.join(__dirname, "..", "drizzle");

async function main() {
  const client = new Client({ connectionString: process.env.HUTCH_DATABASE_URL || process.env.DATABASE_URL });
  await client.connect();

  await client.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL UNIQUE,
      created_at bigint
    )
  `);

  const { rows } = await client.query(
    `SELECT hash FROM drizzle.__drizzle_migrations`,
  );
  const applied = new Set(rows.map((r) => r.hash));

  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  );

  for (const entry of journal.entries) {
    if (applied.has(entry.tag)) continue;

    const sql = fs.readFileSync(
      path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
      "utf8",
    );
    const statements = sql
      .split(/-->\s*statement-breakpoint/i)
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      await client.query("BEGIN");
      for (const stmt of statements) await client.query(stmt);
      await client.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
        [entry.tag, entry.when],
      );
      await client.query("COMMIT");
      console.log(`applied ${entry.tag}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }

  await client.end();
  console.log("migrations complete.");
}

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
