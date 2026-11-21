import type { PoolClient } from 'pg';

import { abortableDelay } from './abortable-delay';
import { activeFrame } from './active-frame';
import { appSettingNames } from './app-setting-names';
import { beginCommand } from './begin-command';
import { NESTED_TRANSACTION } from './constants/nested-transaction.constant';
import { SESSION_BASELINE } from './constants/session-baseline.constant';
import { TRANSACTION_DEFAULTS } from './constants/transaction-defaults.constant';
import { TRANSACTION_STAGE } from './constants/transaction-stage.constant';
import { drizzleSessionOf } from './drizzle-session-of';
import { isPool } from './is-pool';
import { isRetryable } from './is-retryable';
import { localSettings } from './local-settings';
import { NestedTransactionError } from './nested-transaction.error';
import { notifyObserver } from './notify-observer';
import { resolveRetry } from './resolve-retry';
import { retryDelayMs } from './retry-delay-ms';
import { runAttempt } from './run-attempt';
import { runSavepoint } from './run-savepoint';
import { timeoutMs } from './timeout-ms';
import { TransactionRetryAbortedError } from './transaction-retry-aborted.error';
import type { AttemptFailure } from './types/attempt-failure.type';
import type { PoolDatabase } from './types/pool-database.type';
import type { TransactionHandle } from './types/transaction-handle.type';
import type { TransactionOf } from './types/transaction-of.type';
import type { TransactionOptions } from './types/transaction-options.type';

/**
 * Транзакция на отдельном соединении пула, после которой наружу уходит
 * ИСХОДНЫЙ отказ, а соединение возвращается в пул исправным или уничтожается.
 *
 * `db.transaction` drizzle-orm 0.45.2 не годится — у него три дефекта,
 * проверенных на настоящей базе (спека рядом):
 *  - BEGIN выполняется ДО блока try: при его отказе соединение не возвращается
 *    в пул никогда, и десять таких отказов подвешивают всё обращение к базе;
 *  - отказ COMMIT на оборвавшемся соединении подменяется отказом ROLLBACK —
 *    разбор инцидента начинается с ложной причины;
 *  - соединение, на котором откат не прошёл, возвращается в пул как исправное.
 * Сверх того: COMMIT, на который сервер ответил ROLLBACK, — отказ
 * (`CommitRolledBackError`), а не успех при пустой базе; обрыв после отправки
 * COMMIT — `CommitOutcomeUnknownError` (могло зафиксироваться), а не «упало»;
 * разрыв сессии сервером, пока работа ждёт, — `TransactionConnectionLostError`,
 * а не падение процесса на `'error'` без слушателя.
 *
 * Работа получает транзакцию Drizzle над сессией этого соединения: вложенный
 * `tx.transaction(...)` становится точкой сохранения, а не BEGIN/COMMIT внутри
 * внешней транзакции. Диалект (`casing`), схема (`tx.query.*`, в том числе
 * у вложенной), логгер и кэш берутся из базы вызывающего — так же, как их
 * берёт `db.transaction` drizzle. Вызов `transactionKeepingFailure` внутри
 * работы транзакции того же пула — отказ `NestedTransactionError` (он ждал бы
 * второе соединение, пока внешний держит первое) или, с `nested: savepoint`,
 * точка сохранения.
 *
 * Вторым аргументом работа получает само соединение транзакции — для сырого
 * SQL с `$1…$n` (`client.query(text, params)`) в ТУ ЖЕ транзакцию (так код,
 * переехавший с TypeORM `DataSource.transaction`, пишет сырой SQL рядом
 * с Drizzle). Управлять транзакцией через него (BEGIN/COMMIT/ROLLBACK) нельзя;
 * `release()` и запрос после конца транзакции — `TransactionClientMisuseError`.
 *
 * `options.signal` останавливает повторы: новая попытка не начинается, пауза
 * между попытками и ожидание соединения пула прерываются. Уже идущую работу
 * отмена не прерывает — работа слушает сигнал сама.
 *
 * Тип транзакции (`Tx`) выводится из работы вызывающего: проект объявляет
 * свой (например, `AppTransaction`), и с классом Drizzle пакета он не
 * сравнивается (почему — `PoolDatabase`). Ограничение `TransactionHandle`
 * держит главное: корневой клиент вместо транзакции не компилируется.
 */
export async function transactionKeepingFailure<
  T,
  Db extends PoolDatabase = PoolDatabase,
  Tx extends TransactionHandle = TransactionOf<Db>,
>(db: Db, work: (tx: Tx, client: PoolClient) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
  // `drizzle(pool)` кладёт пул в `$client`; `null`/`undefined` — тот же отказ, а не TypeError.
  const pool = (db as { $client?: unknown } | null | undefined)?.$client;
  if (!isPool(pool)) {
    throw new Error('transactionKeepingFailure: база обязана быть над пулом pg (drizzle(pool))');
  }
  const nested = options.nested ?? NESTED_TRANSACTION.refuse;
  if (!Object.values(NESTED_TRANSACTION).includes(nested)) {
    throw new Error(`transactionKeepingFailure: nested — ${Object.values(NESTED_TRANSACTION).join(' | ')}`);
  }
  const outer = activeFrame(pool);
  if (outer !== undefined) {
    if (nested === NESTED_TRANSACTION.refuse) {
      throw new NestedTransactionError();
    }
    return runSavepoint(outer, work, options);
  }
  if (options.transactionPooler === true && options.resetSession === true) {
    throw new Error(
      'transactionKeepingFailure: resetSession под пулером в transaction mode бессмыслен — уборка ушла бы ' +
        'в чужое серверное соединение; уборку делает сам пулер (server_reset_query)',
    );
  }
  if (options.sessionBaseline !== undefined) {
    if (options.resetSession !== true) {
      throw new Error(
        'transactionKeepingFailure: sessionBaseline — только вместе с resetSession (это базовая линия уборки сессии)',
      );
    }
    if (!Object.values(SESSION_BASELINE).includes(options.sessionBaseline)) {
      throw new Error(
        `transactionKeepingFailure: sessionBaseline — ${Object.values(SESSION_BASELINE).join(' | ')}`,
      );
    }
  }
  if (options.sessionStateCheck !== undefined && options.transactionPooler !== true) {
    throw new Error(
      'transactionKeepingFailure: sessionStateCheck — только вместе с transactionPooler (сверяется серверное соединение пулера)',
    );
  }
  const begin = beginCommand(options);
  const settings = localSettings(options);
  const appSettings = appSettingNames(options);
  const retry = resolveRetry(options.retry);
  const rollbackTimeoutMs =
    timeoutMs('rollbackTimeoutMs', options.rollbackTimeoutMs) ?? TRANSACTION_DEFAULTS.ROLLBACK_TIMEOUT_MS;
  const source = drizzleSessionOf(db);
  for (let attempt = 1; ; attempt += 1) {
    const failure: AttemptFailure = { stage: TRANSACTION_STAGE.begin, error: undefined };
    try {
      return await runAttempt({
        pool,
        source,
        begin,
        settings,
        appSettings,
        work,
        options,
        rollbackTimeoutMs,
        failure,
      });
    } catch (error) {
      // Отказ после отмены не повторяется: вызывающий уже ушёл.
      let willRetry = false;
      let thrown: unknown = error;
      try {
        willRetry =
          attempt < retry.attempts &&
          options.signal?.aborted !== true &&
          isRetryable(failure.error ?? error, failure.stage, retry);
      } catch (callbackFailure) {
        // `retry.when` бросил (`TransactionCallbackError`): повтора нет, наружу — его отказ.
        thrown = callbackFailure;
      }
      notifyObserver(options.observer?.attemptFailed, { attempt, stage: failure.stage, error, willRetry });
      if (!willRetry) {
        throw thrown;
      }
      try {
        await abortableDelay(retryDelayMs(attempt, retry.backoffMs, Math.random), options.signal);
      } catch (reason) {
        throw new TransactionRetryAbortedError(reason, error);
      }
    }
  }
}
