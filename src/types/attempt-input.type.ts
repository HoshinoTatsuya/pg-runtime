import type { Pool, PoolClient } from 'pg';

import type { AttemptFailure } from './attempt-failure.type';
import type { DrizzleSessionSource } from './drizzle-session-source.type';
import type { TransactionOptions } from './transaction-options.type';

/** Всё, что попытка транзакции получает от проверенного вызова. */
export interface AttemptInput<T, Tx> {
  readonly pool: Pool;
  readonly source: DrizzleSessionSource | undefined;
  readonly begin: string;
  readonly settings: readonly [string, string][];
  /** Свои параметры, сбрасываемые в конце работы (`resetAppSettings`), проверенные. */
  readonly appSettings: readonly string[];
  readonly work: (tx: Tx, client: PoolClient) => Promise<T>;
  readonly options: TransactionOptions;
  readonly rollbackTimeoutMs: number;
  readonly failure: AttemptFailure;
}
