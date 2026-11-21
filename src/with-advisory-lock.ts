import type { PoolClient } from 'pg';

import { acquireAdvisoryLock } from './acquire-advisory-lock';
import { advisoryLockKeySql } from './advisory-lock-key-sql';
import { lockWaitSettings } from './lock-wait-settings';
import { transactionKeepingFailure } from './transaction-keeping-failure';
import type { AdvisoryLockKey } from './types/advisory-lock-key.type';
import type { AdvisoryXactLockOptions } from './types/advisory-xact-lock-options.type';
import type { PoolDatabase } from './types/pool-database.type';
import type { TransactionHandle } from './types/transaction-handle.type';
import type { TransactionOf } from './types/transaction-of.type';

/**
 * Работа в транзакции под advisory-локом транзакции (`pg_advisory_xact_lock`):
 * лок берётся первым оператором, снимается концом транзакции — и при обрыве
 * тоже, без явного unlock. Лок занят дольше `timeoutMs` —
 * `AdvisoryLockTimeoutError`, работа не запускается. Остальные опции — опции
 * `transactionKeepingFailure` (повтор повторяет и взятие лока).
 */
export async function withAdvisoryLock<
  T,
  Db extends PoolDatabase = PoolDatabase,
  Tx extends TransactionHandle = TransactionOf<Db>,
>(
  db: Db,
  key: AdvisoryLockKey,
  work: (tx: Tx, client: PoolClient) => Promise<T>,
  options: AdvisoryXactLockOptions,
): Promise<T> {
  const lockKey = advisoryLockKeySql(key);
  const wait = lockWaitSettings(options);
  const { timeoutMs: _timeoutMs, pollMs: _pollMs, ...transactionOptions } = options;
  return transactionKeepingFailure<T, Db, Tx>(
    db,
    async (tx, client) => {
      await acquireAdvisoryLock(
        client,
        'pg_try_advisory_xact_lock',
        lockKey,
        wait.timeoutMs,
        wait.pollMs,
        options.signal,
        // Сокет закрыт на запросе опроса: транзакция увидит обрыв на ROLLBACK
        // и уничтожит соединение сама.
        () => undefined,
      );
      return work(tx, client);
    },
    transactionOptions,
  );
}
