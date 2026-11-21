import {
  AdvisoryLockTimeoutError,
  withAdvisoryLock,
  withSessionAdvisoryLock,
} from '@hoshinotatsuya/pg-runtime';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

type Db = NodePgDatabase & { $client: Pool };

/** One invoice run per customer at a time; the lock is released by the end of the transaction. */
export async function runInvoicing(db: Db, customerId: number): Promise<'done' | 'busy'> {
  try {
    await withAdvisoryLock(
      db,
      `invoicing:${customerId}`, // string keys are hashed with hashtextextended (64 bits)
      async (tx) => {
        await tx.execute(sql`UPDATE invoices SET state = 'issued' WHERE customer_id = ${customerId}`);
      },
      { timeoutMs: 5_000 },
    );
    return 'done';
  } catch (error) {
    if (error instanceof AdvisoryLockTimeoutError) {
      return 'busy'; // another session holds the lock; the work did not run
    }
    throw error;
  }
}

/** A long process with its own transactions under a session lock held by a dedicated connection. */
export function rebuildSearchIndex(pool: Pool) {
  return withSessionAdvisoryLock(
    pool,
    'search-index-rebuild',
    async (client) => {
      await client.query('BEGIN');
      try {
        await client.query('DELETE FROM search_index');
        await client.query('INSERT INTO search_index SELECT id, body FROM documents');
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    },
    { timeoutMs: 60_000 },
  );
}
