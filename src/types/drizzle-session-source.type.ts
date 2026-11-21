import type { RelationalSchemaConfig, TablesRelationalConfig } from 'drizzle-orm';
import type { NodePgSessionOptions } from 'drizzle-orm/node-postgres';
import type { PgDialect } from 'drizzle-orm/pg-core';

/** Из чего `db.transaction` drizzle строит транзакцию: диалект, схема, логгер и кэш базы. */
export interface DrizzleSessionSource {
  readonly dialect: PgDialect;
  readonly schema: RelationalSchemaConfig<TablesRelationalConfig> | undefined;
  readonly options: NodePgSessionOptions;
}
