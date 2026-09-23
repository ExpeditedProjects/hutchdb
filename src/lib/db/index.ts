import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

const pool = new Pool({
  connectionString: process.env.HUTCH_DATABASE_URL || process.env.DATABASE_URL,
  statement_timeout: 5000,
  idle_in_transaction_session_timeout: 10000,
});

export const db = drizzle(pool, { schema });
