import type { SQL } from 'drizzle-orm';
import type { PoolClient } from 'pg';

import type { DrizzleSessionSource } from './drizzle-session-source.type';

/**
 * Транзакция, внутри работы которой исполняется код (AsyncLocalStorage).
 * `ended` — работа вернулась: продолжение, пережившее её (таймер, забытый
 * await), вложенным уже не считается.
 */
export interface TransactionFrame {
  readonly pool: object;
  /** Транзакция drizzle этой работы: через неё идут SAVEPOINT/RELEASE/ROLLBACK TO вложенной. */
  readonly transaction: { execute(query: SQL): PromiseLike<unknown> };
  readonly client: PoolClient;
  /** Из чего строится сессия вложенной точки сохранения: диалект, схема, логгер и кэш базы. */
  readonly source: DrizzleSessionSource;
  /** Глубина вложенности: 0 — внешняя транзакция; точка сохранения — `sp${depth + 1}`. */
  readonly depth: number;
  /** Внешняя транзакция идёт с `transactionPooler`: защита пулера стоит на её соединении. */
  readonly transactionPooler: boolean;
  ended: boolean;
}
