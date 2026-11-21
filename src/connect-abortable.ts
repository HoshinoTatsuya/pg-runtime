import type { Pool, PoolClient } from 'pg';

/**
 * Соединение пула с прерываемым ожиданием: пул без свободных соединений
 * (`connectionTimeoutMillis` по умолчанию 0 — ждать вечно) держал бы
 * отменённый вызов бессрочно. Соединение, пришедшее после отмены, уходит
 * обратно в пул, а не теряется.
 */
export function connectAbortable(pool: Pool, signal: AbortSignal | undefined): Promise<PoolClient> {
  if (signal === undefined) {
    return pool.connect();
  }
  // Отменённый вызов не начинает попытку: ни соединения, ни BEGIN.
  signal.throwIfAborted();
  const pending = pool.connect();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason);
      // Отказ возврата позднего соединения — некому отдать (вызывающий уже
      // получил signal.reason): без обработчика он был бы unhandled rejection.
      pending
        .then(
          (late) => late.release(),
          () => undefined,
        )
        .catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (client) => {
        signal.removeEventListener('abort', onAbort);
        resolve(client);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
