import { CommitOutcomeUnknownError, transactionKeepingFailure } from '@hoshinotatsuya/pg-runtime';
import { drizzle } from 'drizzle-orm/node-postgres';
import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';

export const orders = pgTable('orders', {
  id: serial('id').primaryKey(),
  customer: text('customer').notNull(),
  total: integer('total').notNull(),
});

export function createDb(connectionString: string) {
  // query_timeout is the only ceiling on BEGIN/COMMIT on a frozen network: always set it.
  const pool = new Pool({ connectionString, max: 10, query_timeout: 10_000 });
  return { pool, db: drizzle(pool) };
}

type Db = ReturnType<typeof createDb>['db'];

export async function placeOrder(db: Db, customer: string, total: number): Promise<number> {
  try {
    return await transactionKeepingFailure(db, async (tx) => {
      const [row] = await tx.insert(orders).values({ customer, total }).returning({ id: orders.id });
      if (row === undefined) {
        throw new Error('INSERT … RETURNING returned no row');
      }
      return row.id;
    });
  } catch (error) {
    if (error instanceof CommitOutcomeUnknownError) {
      // The connection broke after COMMIT was sent: the order MAY be stored.
      // Look it up by a business key before trying again.
    }
    throw error;
  }
}
