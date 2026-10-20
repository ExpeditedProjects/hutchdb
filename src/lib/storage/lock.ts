import { db } from "@/lib/db";
import { collections } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";

/** A drizzle transaction handle. */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** The db or a transaction: both can execute, select and open (nested) transactions. */
export type Conn = typeof db | DbTx;

/**
 * Class id of the per-collection write lock, a Postgres advisory lock keyed
 * (WRITE_LOCK_CLASS, collection id). 0x48555443 is "HUTC".
 *
 * Every write to a collection's rows (both layouts) runs in a transaction
 * that first takes this lock SHARED, so writers never block each other.
 * The storage migration takes it EXCLUSIVE while it copies a collection
 * and flips its layout, and so does a rollback: writes to that one
 * collection wait, reads (which never take it) carry on. Because a writer
 * re-reads the collection row after the lock is granted, a write that
 * waited out a swap sees the new layout and lands in the new table.
 *
 * The coordination functions (claim/renew/release) will replace this; until
 * then it is the narrowest mechanism that makes the copy step safe.
 */
export const WRITE_LOCK_CLASS = 0x48555443;

export type LockedCollection = typeof collections.$inferSelect;

/**
 * Run `fn` in a transaction holding `collection`'s write lock (shared),
 * with the collection row re-read once the lock is granted (its layout may
 * have changed while the write waited). `fn` gets `undefined` when the
 * collection was deleted meanwhile.
 */
export async function withCollectionWriteLock<T>(
  collection: { id: number },
  fn: (tx: DbTx, collection: LockedCollection | undefined) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${WRITE_LOCK_CLASS}::int, ${collection.id}::int)`);
    const [fresh] = await tx.select().from(collections).where(eq(collections.id, collection.id));
    return fn(tx, fresh);
  });
}

/**
 * Take the collection's write lock exclusively for the rest of `tx`. Waits
 * at most `lockTimeout` for writers already inside a transaction to finish,
 * then throws (SQLSTATE 55P03) rather than stalling every later writer
 * queued behind the request.
 */
export async function lockCollectionExclusive(tx: DbTx, collectionId: number, lockTimeout = "5s"): Promise<void> {
  await tx.execute(sql`SELECT set_config('lock_timeout', ${lockTimeout}, true)`);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${WRITE_LOCK_CLASS}::int, ${collectionId}::int)`);
  await tx.execute(sql`SELECT set_config('lock_timeout', '0', true)`);
}
