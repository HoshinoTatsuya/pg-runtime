import { transactionKeepingFailure, withTenant } from '@hoshinotatsuya/pg-runtime';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

type Db = NodePgDatabase & { $client: Pool };

// RLS policy on the table, for example:
//   CREATE POLICY own ON notes USING (tenant = current_setting('app.tenant_id', true));
export function notesOf(db: Db, tenantId: string) {
  return transactionKeepingFailure(db, async (tx) => {
    await withTenant(tx, tenantId); // set_config('app.tenant_id', tenantId, true): this transaction only
    const result = await tx.execute<{ body: string }>(sql`SELECT body FROM notes ORDER BY body`);
    return result.rows.map((row) => row.body);
  });
}

// The same context without the extra round trip: sent together with the timeouts.
export function notesOfWithoutExtraQuery(db: Db, tenantId: string) {
  return transactionKeepingFailure(
    db,
    async (tx) => (await tx.execute<{ body: string }>(sql`SELECT body FROM notes`)).rows,
    { localSettings: { 'app.tenant_id': tenantId } },
  );
}
