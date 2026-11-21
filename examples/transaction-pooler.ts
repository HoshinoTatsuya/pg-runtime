import {
  assertPoolerCompatible,
  PoolerIncompatibleError,
  SessionStateLeakError,
  transactionKeepingFailure,
} from '@hoshinotatsuya/pg-runtime';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

// Behind PgBouncer/Odyssey in transaction mode. Fails at startup on startup parameters
// (options, statement_timeout, PGOPTIONS, pg.defaults) that the pooler rejects or silently drops.
export function createPoolerDb(connectionString: string) {
  const pool = new Pool({ connectionString, max: 20, query_timeout: 10_000 });
  assertPoolerCompatible(pool);
  return drizzle(pool);
}

export async function touch(db: ReturnType<typeof createPoolerDb>, id: number) {
  try {
    await transactionKeepingFailure(
      db,
      async (tx) => {
        await tx.execute(sql`SET LOCAL work_mem = '64MB'`); // allowed: transaction-scoped
        await tx.execute(sql`UPDATE items SET touched_at = now() WHERE id = ${id}`);
      },
      { transactionPooler: true, resetAppSettings: ['app.request_reason'] },
    );
  } catch (error) {
    if (error instanceof PoolerIncompatibleError) {
      // A session-level statement (SET without LOCAL, LISTEN, PREPARE, …) was refused before it was sent.
    }
    if (error instanceof SessionStateLeakError) {
      // The work changed server session state bypassing the text filter (DO block, function, EXECUTE).
      // error.committed tells whether the work was committed; error.changes lists what changed.
    }
    throw error;
  }
}
