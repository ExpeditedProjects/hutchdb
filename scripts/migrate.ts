import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";

const pool = new Pool({
  connectionString: process.env.HUTCH_DATABASE_URL || process.env.DATABASE_URL,
});

const db = drizzle(pool);

// Migrations 0000–0006 were applied via `drizzle-kit push` before we switched
// to `migrate()`. Seed the journal so they aren't re-run.
const ALREADY_APPLIED = [
  { hash: "0000_abandoned_old_lace", created_at: 1776288539225 },
  { hash: "0001_strong_skrulls", created_at: 1776350317277 },
  { hash: "0002_married_ezekiel_stane", created_at: 1776350936698 },
  { hash: "0003_next_azazel", created_at: 1776539553941 },
  { hash: "0004_auth_js_migration", created_at: 1776710400000 },
  { hash: "0005_better_auth_migration", created_at: 1776883200000 },
  { hash: "0006_mcp_oauth_tables", created_at: 1777056000000 },
];

async function seedJournal() {
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  // Check if already seeded
  const existing = await db.execute(sql`
    SELECT count(*)::int as cnt FROM "drizzle"."__drizzle_migrations"
  `);
  const count = (existing.rows[0] as { cnt: number }).cnt;
  if (count > 0) {
    console.log(`Migration journal already has ${count} entries, skipping seed.`);
    return;
  }

  // Seed the already-applied migrations
  for (const m of ALREADY_APPLIED) {
    await db.execute(sql`
      INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
      VALUES (${m.hash}, ${m.created_at})
    `);
  }
  console.log(`Seeded ${ALREADY_APPLIED.length} existing migrations into journal.`);
}

async function main() {
  await seedJournal();
  console.log("Running migrations...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations complete.");
  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
