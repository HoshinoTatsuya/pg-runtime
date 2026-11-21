import type { NodePgSessionOptions } from 'drizzle-orm/node-postgres';
import type { PgDialect } from 'drizzle-orm/pg-core';

import type { DrizzleSessionSource } from './types/drizzle-session-source.type';
import type { PoolDatabase } from './types/pool-database.type';

/**
 * Сессия базы вызывающего (`db._.session`) — по форме, а не `instanceof`: при
 * двух копиях drizzle-orm в монорепозитории классы у базы другие. Без неё
 * (база собрана не `drizzle(...)`) — диалект по умолчанию и без схемы:
 * `tx.query.*` тогда нет, и обращение к нему — TypeError, а не тишина.
 */
export function drizzleSessionOf(db: PoolDatabase): DrizzleSessionSource | undefined {
  const session = (db as { _?: { session?: unknown } })._?.session as
    | { dialect?: unknown; schema?: unknown; options?: unknown }
    | undefined;
  const dialect = session?.dialect as { sqlToQuery?: unknown } | undefined;
  if (typeof dialect?.sqlToQuery !== 'function') {
    return undefined;
  }
  return {
    dialect: dialect as PgDialect,
    schema: session?.schema as DrizzleSessionSource['schema'],
    options: (session?.options ?? {}) as NodePgSessionOptions,
  };
}
