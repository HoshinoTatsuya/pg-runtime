import {
  ISOLATION_LEVEL,
  RETRY_REASON,
  TransactionRetryAbortedError,
  transactionKeepingFailure,
} from '@hoshinotatsuya/pg-runtime';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

type Db = NodePgDatabase & { $client: Pool };

export async function transfer(db: Db, from: number, to: number, amount: number, signal: AbortSignal) {
  try {
    await transactionKeepingFailure(
      db,
      async (tx) => {
        await tx.execute(sql`UPDATE accounts SET balance = balance - ${amount} WHERE id = ${from}`);
        await tx.execute(sql`UPDATE accounts SET balance = balance + ${amount} WHERE id = ${to}`);
      },
      {
        isolationLevel: ISOLATION_LEVEL.serializable,
        lockTimeoutMs: 2_000, // SET LOCAL lock_timeout
        statementTimeoutMs: 30_000, // SET LOCAL statement_timeout
        idleInTransactionTimeoutMs: 60_000, // SET LOCAL idle_in_transaction_session_timeout
        // The WHOLE work runs again on each retry: keep it idempotent and free of external side effects.
        retry: { attempts: 3, backoffMs: 50, on: [RETRY_REASON.serialization, RETRY_REASON.deadlock] },
        signal, // stops waiting for a connection and between retries
        observer: {
          connectionAcquired: ({ waitMs }) => console.log('pool wait', waitMs),
          connectionDestroyed: ({ stage, error }) =>
            console.warn('connection destroyed', stage, error.message),
          attemptFailed: ({ attempt, willRetry }) => console.warn('attempt failed', attempt, willRetry),
        },
      },
    );
  } catch (error) {
    if (error instanceof TransactionRetryAbortedError && error.reason === signal.reason) {
      return; // cancelled between attempts; error.cause holds the last failure (e.g. 40001)
    }
    throw error;
  }
}

/** Work that changes session state (SET, LISTEN, temp tables) — clean the connection before it returns to the pool. */
export function withSessionCleanup(db: Db) {
  return transactionKeepingFailure(
    db,
    async (tx) => {
      await tx.execute(sql`SET search_path = reporting, public`);
      await tx.execute(sql`SELECT 1`);
    },
    { resetSession: true }, // restores the state the connection had after pool.on('connect')
  );
}
