import { SESSION_ENDING_SQLSTATE } from './constants/session-ending-sqlstate.constant';
import { errorChain } from './error-chain';

/**
 * Отказ — обрыв соединения, а не ответ сервера на запрос: серверного отказа
 * (`severity` + `code`) в цепочке нет вовсе (сокет, «Connection terminated»,
 * «not queryable»), либо он FATAL/PANIC, класса 08 или 57P01–57P03. Сервер,
 * ответивший ERROR, жив и сессию не закрыл.
 */
export function isConnectionFailure(error: unknown): boolean {
  const server = errorChain(error).find(
    (link): link is { severity: string; code: string } =>
      typeof (link as { severity?: unknown }).severity === 'string' &&
      typeof (link as { code?: unknown }).code === 'string',
  );
  if (server === undefined) {
    return true;
  }
  return (
    server.severity === 'FATAL' ||
    server.severity === 'PANIC' ||
    server.code.startsWith('08') ||
    SESSION_ENDING_SQLSTATE.includes(server.code)
  );
}
