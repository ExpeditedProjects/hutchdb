import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { sql } from "drizzle-orm";

// Real-Postgres check that the shared pool survives the server killing an idle
// connection. Without a pool "error" listener this crashes the process — the
// suspected cause of the intermittent 502s on hosted MCP writes.
//
// Auto-skipped when HUTCH_TEST_DATABASE_URL is not set.
const TEST_DB_URL = process.env.HUTCH_TEST_DATABASE_URL;

describe.skipIf(!TEST_DB_URL)("db pool resilience (real Postgres)", () => {
  let admin: Pool;
  let mod: typeof import("@/lib/db");

  beforeAll(async () => {
    process.env.HUTCH_DATABASE_URL = TEST_DB_URL;
    mod = await import("@/lib/db");
    admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  });

  afterAll(async () => {
    await mod?.pool.end();
    await admin?.end();
  });

  it("keeps serving queries after an idle connection is terminated server-side", async () => {
    const first = await mod.db.execute(sql`select pg_backend_pid() as pid`);
    const pid = Number(first.rows[0].pid);
    expect(mod.pool.idleCount).toBe(1);

    // Don't attach our own "error" listener — that would mask a missing one.
    await admin.query("select pg_terminate_backend($1)", [pid]);
    await expect.poll(() => mod.pool.totalCount).toBe(0);

    const second = await mod.db.execute(sql`select pg_backend_pid() as pid`);
    expect(Number(second.rows[0].pid)).not.toBe(pid);
  });
});
