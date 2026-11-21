import type { SQL } from 'drizzle-orm';

/** Транзакция drizzle (или что угодно с `execute(sql)`) — куда `withTenant` пишет контекст. */
export interface SqlExecutor {
  execute(query: SQL): PromiseLike<unknown>;
}
