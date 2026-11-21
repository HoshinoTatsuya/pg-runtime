import type { PoolClient } from 'pg';

/**
 * Закрыть сокет соединения сразу. `release(error)` пула зовёт `client.end()`:
 * он шлёт Terminate и ждёт ответа сервера — на замёрзшей сети сокет висел бы
 * открытым (и держал бы цикл событий) до таймаута TCP. Сокет берётся по форме:
 * у pg это `client.connection.stream`.
 */
export function destroyConnection(client: PoolClient): void {
  const stream = (client as unknown as { connection?: { stream?: { destroy?: () => void } } }).connection
    ?.stream;
  stream?.destroy?.();
}
