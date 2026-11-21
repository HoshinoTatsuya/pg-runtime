import { NodePgSession, NodePgTransaction } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';

import { commitFailure } from './commit-failure';
import { CommitRolledBackError } from './commit-rolled-back.error';
import { connectAbortable } from './connect-abortable';
import { APP_SETTINGS_RESET_SQL } from './constants/app-settings-reset.constant';
import { IN_FAILED_TRANSACTION } from './constants/in-failed-transaction.constant';
import { NO_ACTIVE_TRANSACTION } from './constants/no-active-transaction.constant';
import { SESSION_BASELINE } from './constants/session-baseline.constant';
import { SESSION_PROBE_SQL } from './constants/session-probe.constant';
import { SESSION_RESET_SQL } from './constants/session-reset.constant';
import { TRANSACTION_COMMAND } from './constants/transaction-command.constant';
import { TRANSACTION_STAGE } from './constants/transaction-stage.constant';
import { guardedClient } from './guarded-client';
import { ManualTransactionControlError } from './manual-transaction-control.error';
import { notifyObserver } from './notify-observer';
import { queryWithCeiling } from './query-with-ceiling';
import { removeWorkListeners } from './remove-work-listeners';
import { sessionLeak } from './session-leak';
import { sessionResetSql } from './session-reset-sql';
import { SESSION_RESETS } from './session-resets';
import { sessionStateOf } from './session-state-of';
import { toError } from './to-error';
import { trackedQuery } from './tracked-query';
import { TransactionCallbackError } from './transaction-callback.error';
import { TransactionConnectionLostError } from './transaction-connection-lost.error';
import { TRANSACTION_CONTEXT } from './transaction-context';
import type { AttemptInput } from './types/attempt-input.type';
import type { SessionState } from './types/session-state.type';
import type { TransactionFrame } from './types/transaction-frame.type';
import type { TransactionHandle } from './types/transaction-handle.type';
import type { TransactionStage } from './types/transaction-stage.type';

/**
 * Одна попытка транзакции на своём соединении пула.
 *
 * Обработчик `'error'` ставится сразу после выдачи: pg-pool снимает свой, и
 * разрыв сессии сервером без активного запроса (idle_in_transaction timeout,
 * pg_terminate_backend, рестарт, failover, RST) был бы `emit('error')` без
 * слушателя — падением процесса. Разрыв запоминается: соединение уничтожается,
 * наружу — `TransactionConnectionLostError` с причиной сервера, а не «not
 * queryable» следующего запроса работы. Снимается обработчик прямо перед
 * `release`, и пул в тот же момент ставит свой.
 *
 * Под пулером в transaction mode (`transactionPooler`) состояние серверного
 * соединения сверяется: снимок тем же сообщением, что BEGIN, и тем же, что
 * COMMIT/ROLLBACK (пулер держит серверное соединение до готовности после всего
 * сообщения). Разница — `SessionStateLeakError`. Не сверяется, когда
 * транзакции к концу уже не было (работа сама завершила её, COMMIT отказал):
 * пулер мог отдать запрос другому серверному соединению.
 */
export async function runAttempt<T, Tx extends TransactionHandle>(input: AttemptInput<T, Tx>): Promise<T> {
  const { pool, source, begin, settings, appSettings, work, options, rollbackTimeoutMs, failure } = input;
  const wrap = options.wrapFailure ?? ((_stage: TransactionStage, error: unknown) => error);
  failure.stage = TRANSACTION_STAGE.begin;
  const waitStarted = performance.now();
  let client: PoolClient;
  try {
    client = await connectAbortable(pool, options.signal);
  } catch (error) {
    failure.error = error;
    throw error;
  }
  notifyObserver(options.observer?.connectionAcquired, { waitMs: performance.now() - waitStarted });
  let broken: Error | undefined;
  let lost: { readonly stage: TransactionStage; readonly error: Error } | undefined;
  // Сокет закрыли мы (потолок ROLLBACK): последующее «Connection terminated» —
  // наше же действие, а не разрыв сервером.
  let destroying = false;
  const onError = (error: Error): void => {
    if (destroying) {
      return;
    }
    lost ??= { stage: failure.stage, error };
    broken ??= error;
  };
  client.on('error', onError);
  const markDestroying = (): void => {
    destroying = true;
  };
  // Транзакция уже закончилась (COMMIT ответил, в том числе ROLLBACK; работа
  // сама завершила её): ROLLBACK вслед дал бы только предупреждение 25P01.
  let ended = false;
  // Работа вернулась (успехом или отказом): дальше её запросы — чужие. Запрос
  // после этого ушёл бы в очередь соединения ПОСЛЕ нашего COMMIT, то есть мимо
  // транзакции, а после release — в транзакцию следующего владельца соединения.
  let workReturned = false;
  const guarded = guardedClient(client, () => workReturned, options.transactionPooler === true);
  // Состояние серверного соединения в начале транзакции (только под пулером).
  let before: SessionState | undefined;
  // Запрос уборки сессии (`resetSession`): к значениям по умолчанию — общий,
  // к состоянию после connect — свой у соединения, из снимка его первой транзакции.
  let reset: string | undefined;
  if (options.resetSession === true) {
    reset =
      options.sessionBaseline === SESSION_BASELINE.defaults ? SESSION_RESET_SQL : SESSION_RESETS.get(client);
  }

  try {
    const checking = options.transactionPooler === true && options.sessionStateCheck !== false;
    // Первая транзакция соединения с уборкой к состоянию после connect: снимок
    // тем же сообщением, что BEGIN, — до работы, и тем же запросом, что сверка
    // под пулером (один источник «что считается состоянием сессии»).
    const baseline = !checking && options.resetSession === true && reset === undefined;
    let snapshot: unknown;
    if (checking || baseline) {
      const answer = (await client.query(`${begin}; ${SESSION_PROBE_SQL}`)) as unknown as ReadonlyArray<{
        rows?: unknown[];
      }>;
      snapshot = answer[1]?.rows?.[0];
    } else {
      await client.query(begin);
    }
    // BEGIN прошёл — транзакция идёт: отказ дальше (разбор снимка, базовая линия,
    // которую уборка не вернёт, параметры) откатывается ROLLBACK на исправном
    // соединении, а не считается отказом BEGIN — тот уничтожал бы соединение и
    // повторялся бы как обрыв (`connection-before-work`).
    failure.stage = TRANSACTION_STAGE.work;
    if (checking) {
      before = sessionStateOf(snapshot);
    } else if (baseline) {
      reset = sessionResetSql(sessionStateOf(snapshot));
      SESSION_RESETS.set(client, reset);
    }
    if (settings.length > 0) {
      // Все настройки — ОДНИМ запросом: по запросу на настройку три таймаута
      // стоили трёх обращений к базе и вдвое снижали пропускную способность
      // (замер в README, «Предел»).
      await client.query(
        `SELECT ${settings.map((_, i) => `set_config($${2 * i + 1}, $${2 * i + 2}, true)`).join(', ')}`,
        settings.flat(),
      );
    }
    // Как `db.transaction` drizzle: сессия над соединением с диалектом, схемой
    // и опциями базы, транзакция — с той же схемой (её наследует вложенная).
    // Сессия строится на ЗАЩИЩЁННОМ соединении: `tx.*` — основной путь запросов
    // работы, и защита только сырого клиента его не покрывала.
    const session = {
      dialect: source?.dialect ?? new PgDialect(),
      schema: source?.schema,
      options: source?.options ?? {},
    };
    const transaction = new NodePgTransaction(
      session.dialect,
      new NodePgSession(guarded, session.dialect, session.schema, session.options),
      session.schema,
    );
    const frame: TransactionFrame = {
      pool,
      transaction,
      client: guarded,
      source: session,
      depth: 0,
      transactionPooler: options.transactionPooler === true,
      ended: false,
    };
    let result: T;
    try {
      result = await TRANSACTION_CONTEXT.run([...(TRANSACTION_CONTEXT.getStore() ?? []), frame], () =>
        work(transaction as unknown as Tx, guarded),
      );
    } finally {
      workReturned = true;
      frame.ended = true;
    }
    if (lost !== undefined) {
      // Работа вернула успех, не заметив разрыва: COMMIT слать не во что.
      throw new TransactionConnectionLostError(lost.stage, lost.error);
    }
    if (appSettings.length > 0) {
      // Сброс своих параметров (`resetAppSettings`) — запрос самого пакета на
      // соединении, а не на защищённом: фильтр пулера отверг бы `set_config(…, false)`.
      // До COMMIT и в той же транзакции: под пулером это то же серверное соединение.
      try {
        await client.query(APP_SETTINGS_RESET_SQL, [appSettings]);
      } catch (error) {
        // Работа поймала отказ запроса и вернула успех: транзакция прервана, COMMIT
        // ответит ROLLBACK (`CommitRolledBackError`), а ROLLBACK снимет сессионные
        // значения работы сам.
        if ((error as { code?: unknown }).code !== IN_FAILED_TRANSACTION) {
          throw error;
        }
      }
    }
    failure.stage = TRANSACTION_STAGE.commit;
    let outsideTransaction = false;
    const onNotice = (notice: { code?: string | undefined }): void => {
      if (notice.code === NO_ACTIVE_TRANSACTION) {
        outsideTransaction = true;
      }
    };
    client.on('notice', onNotice);
    let committed: { command: string };
    // Ответ сверки после COMMIT (под пулером): строка или отказ сверки.
    let probe: { readonly result: unknown } | { readonly error: Error } | undefined;
    try {
      if (before === undefined) {
        committed = await client.query(TRANSACTION_COMMAND.commit);
      } else {
        const completed: string[] = [];
        try {
          const answer = await trackedQuery(
            client,
            `${TRANSACTION_COMMAND.commit}; ${SESSION_PROBE_SQL}`,
            completed,
          );
          committed = (answer as ReadonlyArray<{ command: string }>)[0] as { command: string };
          probe = { result: answer };
        } catch (error) {
          // Тега COMMIT нет — отказал сам COMMIT; есть — отказала сверка после него.
          if (completed.length === 0) {
            throw error;
          }
          committed = { command: (completed[0] as string).split(' ')[0] as string };
          probe = { error: toError(error) };
        }
      }
    } finally {
      client.off('notice', onNotice);
    }
    ended = true;
    let ending: Error | undefined;
    if (outsideTransaction) {
      ending = new ManualTransactionControlError();
    } else if (committed.command === TRANSACTION_COMMAND.rollback) {
      ending = new CommitRolledBackError();
    }
    if (before !== undefined && probe !== undefined && !outsideTransaction) {
      const leak = sessionLeak(before, probe, ending === undefined, ending);
      if (leak !== undefined) {
        throw leak;
      }
    }
    if (ending !== undefined) {
      throw ending;
    }
    return result;
  } catch (error) {
    let thrown: unknown = error;
    if (failure.stage === TRANSACTION_STAGE.begin) {
      // Транзакция не началась — ROLLBACK слать не во что. BEGIN почти не
      // падает по вине запроса: обрыв, таймаут, рестарт сервера (класс 08/57),
      // — поэтому соединение уничтожается всегда, а не отдаётся следующему.
      broken ??= toError(error);
    } else if (!ended) {
      // Сверка после ROLLBACK — когда отказала работа: транзакция ещё открыта, и
      // пулер держит серверное соединение. После отказа COMMIT транзакции уже
      // нет — ROLLBACK мог уйти другому серверному соединению.
      const probing = before !== undefined && failure.stage === TRANSACTION_STAGE.work;
      const completed: string[] = [];
      const rollback = await queryWithCeiling(
        client,
        probing ? `${TRANSACTION_COMMAND.rollback}; ${SESSION_PROBE_SQL}` : TRANSACTION_COMMAND.rollback,
        rollbackTimeoutMs,
        markDestroying,
        probing ? completed : undefined,
      );
      // ROLLBACK прошёл, отказала сверка после него — соединение исправно.
      const probeFailed = !rollback.ok && probing && completed.length > 0;
      if (!rollback.ok && !probeFailed) {
        broken ??= rollback.error;
      }
      if (failure.stage === TRANSACTION_STAGE.commit) {
        thrown = commitFailure(error, rollback);
      } else if (lost !== undefined && !(error instanceof TransactionConnectionLostError)) {
        thrown = new TransactionConnectionLostError(lost.stage, lost.error, error);
      } else if (
        rollback.ok &&
        rollback.notices.includes(NO_ACTIVE_TRANSACTION) &&
        !(error instanceof ManualTransactionControlError)
      ) {
        // Работа сама завершила транзакцию (COMMIT/ROLLBACK) и потом отказала:
        // часть до её COMMIT могла зафиксироваться отдельно. Наружу — не её
        // отказ (его повтор задвоил бы зафиксированное), а ручное управление.
        thrown = new ManualTransactionControlError(error);
      }
      // Работа сама завершила транзакцию (ROLLBACK ответил 25P01) — сверять не с чем:
      // запрос мог уйти другому серверному соединению.
      if (
        before !== undefined &&
        probing &&
        (probeFailed || (rollback.ok && !rollback.notices.includes(NO_ACTIVE_TRANSACTION)))
      ) {
        thrown =
          sessionLeak(
            before,
            rollback.ok ? { result: rollback.result } : { error: rollback.error },
            false,
            thrown,
          ) ?? thrown;
      }
    }
    failure.error = thrown;
    let wrapped: unknown;
    try {
      wrapped = wrap(failure.stage, thrown);
    } catch (callbackError) {
      wrapped = new TransactionCallbackError('wrapFailure', callbackError, thrown);
    }
    throw wrapped;
  } finally {
    workReturned = true;
    // Снимок не взят (отказ BEGIN или отказ на снимке) — соединение уже уничтожается.
    if (broken === undefined && reset !== undefined) {
      const outcome = await queryWithCeiling(client, reset, rollbackTimeoutMs, markDestroying);
      if (!outcome.ok) {
        broken = outcome.error;
      }
    }
    removeWorkListeners(guarded);
    client.off('error', onError);
    // С ошибкой — пул уничтожает соединение, а не отдаёт следующему.
    client.release(broken);
    if (broken !== undefined) {
      notifyObserver(options.observer?.connectionDestroyed, { stage: failure.stage, error: broken });
    }
  }
}
