import type { Pool, PoolClient } from 'pg';

import { acquireAdvisoryLock } from './acquire-advisory-lock';
import { activeFrame } from './active-frame';
import { advisoryLockKeySql } from './advisory-lock-key-sql';
import { AdvisoryLockLostError } from './advisory-lock-lost.error';
import { connectAbortable } from './connect-abortable';
import { TRANSACTION_DEFAULTS } from './constants/transaction-defaults.constant';
import { guardedClient } from './guarded-client';
import { isPool } from './is-pool';
import { lockWaitSettings } from './lock-wait-settings';
import { NestedTransactionError } from './nested-transaction.error';
import { openTransaction } from './open-transaction';
import { poolOf } from './pool-of';
import { PoolerIncompatibleError } from './pooler-incompatible.error';
import { queryWithCeiling } from './query-with-ceiling';
import { removeWorkListeners } from './remove-work-listeners';
import { toError } from './to-error';
import { TransactionLeftOpenError } from './transaction-left-open.error';
import type { AdvisoryLockKey } from './types/advisory-lock-key.type';
import type { AdvisoryLockOptions } from './types/advisory-lock-options.type';
import type { PoolDatabase } from './types/pool-database.type';

/**
 * Работа под сессионным advisory-локом (`pg_advisory_lock`) на отдельном
 * соединении пула: работа идёт ВНЕ транзакции (долгий процесс со своими
 * транзакциями), лок держит это соединение. После работы — `pg_advisory_unlock`
 * с потолком `TRANSACTION_DEFAULTS.ROLLBACK_TIMEOUT_MS`; не прошёл, не ответил
 * или ответил «не держали» — соединение уничтожается, и лок снимает сервер
 * вместе с сессией: соединение с чужим локом в пул не возвращается.
 *
 * Работа идёт вне транзакции пакета, и свои транзакции обязана закрывать:
 * после работы отдельный запрос без параметров проверяет, не осталась ли
 * открытой транзакция (`BEGIN` без `COMMIT`/`ROLLBACK`, прерванная отказом) —
 * осталась: соединение уничтожается (сервер откатит её и снимет лок), наружу
 * `TransactionLeftOpenError`; иначе соединение ушло бы в пул «idle in
 * transaction», и следующий владелец писал бы в чужую транзакцию. Разрыв
 * сессии, пришедший до возврата работы, — `AdvisoryLockLostError`: сервер снял
 * лок посреди работы, и его могла взять другая сессия.
 *
 * Работа получает соединение лока — для запросов в той же сессии; `release()`
 * и `end()` через него — `TransactionClientMisuseError` (соединение с локом ушло
 * бы в пул или закрылось мимо него), запрос после возврата работы — тоже.
 * База — drizzle над пулом или сам пул pg.
 *
 * Внутри работы транзакции того же пула — `NestedTransactionError` до обращения
 * к пулу: вызов ждал бы второе соединение, пока транзакция держит первое (при
 * `max` таких вызовах пул встаёт навсегда). Лок на транзакцию — `withAdvisoryLock`.
 *
 * Под пулером в transaction mode сессионный лок не работает (остаётся на
 * серверном соединении, которое получит другой клиент) — там `withAdvisoryLock`;
 * `transactionPooler: true` — отказ до соединения.
 */
export async function withSessionAdvisoryLock<T>(
  db: PoolDatabase | Pool,
  key: AdvisoryLockKey,
  work: (client: PoolClient) => Promise<T>,
  options: AdvisoryLockOptions,
): Promise<T> {
  const pool = poolOf(db);
  if (!isPool(pool)) {
    throw new Error(
      'withSessionAdvisoryLock: база обязана быть пулом pg или drizzle над ним (drizzle(pool))',
    );
  }
  if (options.transactionPooler === true) {
    throw new PoolerIncompatibleError([
      'сессионный advisory-лок под пулером в transaction mode остаётся на серверном соединении пулера ' +
        '(снятие уходит другому серверному соединению) — нужен withAdvisoryLock',
    ]);
  }
  if (activeFrame(pool) !== undefined) {
    throw new NestedTransactionError(
      'withSessionAdvisoryLock внутри работы транзакции того же пула: вызов ждал бы второе соединение, пока ' +
        'транзакция держит первое, — взаимная блокировка пула. Лок на эту транзакцию — withAdvisoryLock ' +
        '(pg_advisory_xact_lock); сессионный — вызов вне работы транзакции',
    );
  }
  const lockKey = advisoryLockKeySql(key);
  const wait = lockWaitSettings(options);
  const client = await connectAbortable(pool, options.signal);
  let broken: Error | undefined;
  // Сокет закрыли мы (потолок запроса): последующее «Connection terminated» —
  // наше же действие, причина уже записана.
  let destroying = false;
  // Разрыв сессии, пока соединение выдано: без слушателя — падение процесса.
  const onError = (error: Error): void => {
    if (!destroying) {
      broken ??= error;
    }
  };
  client.on('error', onError);
  const markDestroying = (): void => {
    destroying = true;
  };
  let workReturned = false;
  let guarded: PoolClient | undefined;
  try {
    await acquireAdvisoryLock(
      client,
      'pg_try_advisory_lock',
      lockKey,
      wait.timeoutMs,
      wait.pollMs,
      options.signal,
      (reason) => {
        markDestroying();
        broken ??= toError(reason);
      },
    );
    let settled: { readonly value: T } | { readonly error: unknown };
    guarded = guardedClient(client, () => workReturned, false);
    try {
      settled = { value: await work(guarded) };
    } catch (error) {
      settled = { error };
    }
    workReturned = true;
    const workError = 'error' in settled ? settled.error : undefined;
    if (broken !== undefined) {
      // Разрыв пришёл ДО возврата работы: сервер снял лок посреди работы, и
      // другая сессия могла взять его — взаимное исключение нарушено.
      throw new AdvisoryLockLostError(lockKey.label, broken, workError);
    }
    const open = await openTransaction(client, markDestroying);
    if (open.state === 'open') {
      broken = new TransactionLeftOpenError(lockKey.label, workError);
      throw broken;
    }
    if (open.state === 'failed') {
      // Сервер ответил, но не на вопрос: «не смогли определить» — отказ.
      broken = open.error;
      throw open.error;
    }
    if (open.state === 'unreachable') {
      // Соединение оборвалось после работы (или сеть замёрзла): лок снимет
      // сервер вместе с сессией, исход работы — её собственный.
      broken = open.error;
    } else {
      const unlock = await queryWithCeiling(
        client,
        `SELECT pg_advisory_unlock(${lockKey.expression}) AS released`,
        TRANSACTION_DEFAULTS.ROLLBACK_TIMEOUT_MS,
        markDestroying,
        undefined,
        [lockKey.value],
      );
      if (!unlock.ok) {
        broken = unlock.error;
      } else if ((unlock.result as { rows?: Array<{ released?: unknown }> }).rows?.[0]?.released !== true) {
        broken = new Error(`advisory-лок ${lockKey.label} не держался этой сессией к концу работы`);
      }
    }
    if ('error' in settled) {
      throw settled.error;
    }
    return settled.value;
  } finally {
    workReturned = true;
    if (guarded !== undefined) {
      removeWorkListeners(guarded);
    }
    client.off('error', onError);
    client.release(broken);
  }
}
