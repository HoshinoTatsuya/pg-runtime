import type { PoolClient } from 'pg';

import { abortableDelay } from './abortable-delay';
import { AdvisoryLockTimeoutError } from './advisory-lock-timeout.error';
import { TRANSACTION_DEFAULTS } from './constants/transaction-defaults.constant';
import { destroyConnection } from './destroy-connection';
import type { AdvisoryLockKeySql } from './types/advisory-lock-key-sql.type';

/**
 * Взять advisory-лок опросом `pg_try_*` до потолка. Не `pg_advisory_lock` с
 * `lock_timeout`: тот пришлось бы ставить на сессию (и снимать) или на
 * транзакцию (и он ограничил бы все её ожидания), а опрос не трогает
 * параметров и прерывается отменой.
 *
 * Каждый запрос опроса ждёт ответа не дольше остатка потолка (но не меньше
 * `TRANSACTION_DEFAULTS.ROLLBACK_TIMEOUT_MS`: запрос у самого потолка не
 * должен рвать исправное соединение), и отмена прерывает его тоже. Нет ответа
 * или отмена посреди запроса — неизвестно, взят ли лок на сервере, поэтому
 * соединение уничтожается (сервер снимет лок вместе с сессией), `onDestroy`
 * получает причину ДО закрытия сокета. Без этого замёрзшая сеть держала бы
 * вызов и соединение пула до таймаута TCP ОС — минуты поверх `timeoutMs`.
 */
export async function acquireAdvisoryLock(
  client: PoolClient,
  tryFunction: 'pg_try_advisory_lock' | 'pg_try_advisory_xact_lock',
  key: AdvisoryLockKeySql,
  timeoutMs: number,
  pollMs: number,
  signal: AbortSignal | undefined,
  onDestroy: (reason: unknown) => void,
): Promise<void> {
  const startedAt = performance.now();
  for (;;) {
    signal?.throwIfAborted();
    const ceilingMs = Math.max(
      timeoutMs - (performance.now() - startedAt),
      TRANSACTION_DEFAULTS.ROLLBACK_TIMEOUT_MS,
    );
    const pending = client.query<{ locked: boolean }>(`SELECT ${tryFunction}(${key.expression}) AS locked`, [
      key.value,
    ]);
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<{ readonly reason: unknown }>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            reason: new Error(
              `advisory-лок ${key.label}: ${tryFunction} не ответил за ${Math.round(ceilingMs)} мс — ` +
                'соединение уничтожено (лок, если взят, снимет сервер вместе с сессией); работа не запускалась',
            ),
          }),
        ceilingMs,
      );
      onAbort = () => resolve({ reason: signal?.reason });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    let answer: { readonly rows: ReadonlyArray<{ locked: boolean }> } | { readonly reason: unknown };
    try {
      answer = await Promise.race([pending, interrupted]);
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) {
        signal?.removeEventListener('abort', onAbort);
      }
    }
    if ('reason' in answer) {
      // Отказ запроса после закрытия сокета — ожидаемый, его никто не ждёт.
      pending.catch(() => undefined);
      onDestroy(answer.reason);
      destroyConnection(client);
      throw answer.reason;
    }
    if (answer.rows[0]?.locked === true) {
      return;
    }
    const remaining = timeoutMs - (performance.now() - startedAt);
    if (remaining <= 0) {
      throw new AdvisoryLockTimeoutError(key.label, timeoutMs);
    }
    await abortableDelay(Math.min(pollMs, remaining), signal);
  }
}
