import { NESTED_TRANSACTION, transactionKeepingFailure } from '@hoshinotatsuya/pg-runtime';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

type Db = NodePgDatabase & { $client: Pool };

export function markDone(db: Db, jobId: number) {
  // The second argument is the transaction's own PoolClient: raw SQL with $1…$n in the SAME transaction.
  // Never send BEGIN/COMMIT/ROLLBACK through it and never call client.release().
  return transactionKeepingFailure(db, async (tx, client) => {
    await client.query('UPDATE jobs SET status = $1 WHERE id = $2', ['done', jobId]);
    await tx.execute(sql`INSERT INTO job_events (job_id, kind) VALUES (${jobId}, 'done')`);
  });
}

export function auditInsideOuterTransaction(db: Db, jobId: number) {
  return transactionKeepingFailure(db, async () => {
    // A call inside the work of a transaction on the same pool throws NestedTransactionError by default.
    // With nested: savepoint it becomes a SAVEPOINT; its failure rolls back only the inner part.
    await transactionKeepingFailure(
      db,
      async (inner) => {
        await inner.execute(sql`INSERT INTO audit (job_id) VALUES (${jobId})`);
      },
      { nested: NESTED_TRANSACTION.savepoint },
    ).catch(() => undefined);
  });
}
