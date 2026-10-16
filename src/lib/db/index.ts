import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export const pool = new Pool({
  connectionString: process.env.HUTCH_DATABASE_URL || process.env.DATABASE_URL,
  statement_timeout: 5000,
  idle_in_transaction_session_timeout: 10000,
  // Fail fast when the pool is exhausted instead of waiting forever.
  connectionTimeoutMillis: 5000,
  // Drop idle clients before a managed Postgres or its pooler does it for us.
  idleTimeoutMillis: 10000,
});

// When the server drops an idle client (pooler restart, idle reaping, network
// blip), pg emits "error" on the pool. With no listener, Node treats it as
// unhandled and kills the process, along with every in-flight request on it.
// The pool already discards the dead client, so logging is all that's needed.
pool.on("error", (err) => {
  console.error("[db] idle client error", err.message);
});

export const db = drizzle(pool, { schema });
