import { safeText } from './safe-text';
import type { TransactionStage } from './types/transaction-stage.type';

/**
 * Соединение транзакции разорвано до COMMIT: сервер прервал сессию
 * (idle_in_transaction_session_timeout, pg_terminate_backend, рестарт,
 * failover) или оборвался сокет. Транзакция не зафиксирована — сервер
 * откатывает её вместе с сессией; соединение уничтожено. Причина разрыва — в
 * `cause`, отказ запроса работы, который за ним последовал («not queryable»), —
 * в `workError`.
 */
export class TransactionConnectionLostError extends Error {
  public override readonly name: string = 'TransactionConnectionLostError';

  public constructor(
    public readonly stage: TransactionStage,
    cause: unknown,
    public readonly workError?: unknown,
  ) {
    super(
      `соединение транзакции разорвано на стадии ${stage}, ничего не зафиксировано: ` + `${safeText(cause)}`,
      { cause },
    );
  }
}
