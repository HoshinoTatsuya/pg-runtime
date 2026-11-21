import { CommitOutcomeUnknownError } from './commit-outcome-unknown.error';
import { NO_ACTIVE_TRANSACTION } from './constants/no-active-transaction.constant';
import { isConnectionFailure } from './is-connection-failure';
import type { CeilingOutcome } from './types/ceiling-outcome.type';

/**
 * Что сказать вызывающему об отказе COMMIT.
 *  - Сервер ответил на COMMIT ошибкой (ERROR: отложенное ограничение, 40001
 *    при фиксации) — исход известен: не записано; наружу сам отказ.
 *  - Ответа сервера нет (обрыв), но следующий ROLLBACK прошёл на том же
 *    соединении БЕЗ предупреждения 25P01 — транзакция была ещё открыта, COMMIT
 *    до сервера не дошёл: тоже известно, тоже сам отказ.
 *  - Иначе COMMIT мог быть выполнен — `CommitOutcomeUnknownError`.
 */
export function commitFailure(error: unknown, rollback: CeilingOutcome): unknown {
  if (!isConnectionFailure(error)) {
    return error;
  }
  if (rollback.ok && !rollback.notices.includes(NO_ACTIVE_TRANSACTION)) {
    return error;
  }
  return new CommitOutcomeUnknownError(error);
}
