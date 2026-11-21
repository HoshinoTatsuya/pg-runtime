import { TRANSACTION_STAGE } from './constants/transaction-stage.constant';
import { safeText } from './safe-text';
import { TransactionConnectionLostError } from './transaction-connection-lost.error';

/**
 * Сессия `withSessionAdvisoryLock` разорвана, пока шла работа
 * (`pg_terminate_backend`, рестарт, failover, обрыв сокета): сервер снял лок
 * вместе с сессией, и другая сессия могла взять его ДО конца работы —
 * взаимное исключение нарушено. То, что работа зафиксировала своими
 * транзакциями, зафиксировано; результат работы вызывающему не отдаётся.
 * Стадия — `work`, причина разрыва — в `cause`, отказ работы, если был, — в
 * `workError`. Подкласс `TransactionConnectionLostError`: разбор по нему
 * продолжает работать.
 */
export class AdvisoryLockLostError extends TransactionConnectionLostError {
  public override readonly name: string = 'AdvisoryLockLostError';

  public constructor(
    public readonly lock: string,
    cause: unknown,
    workError?: unknown,
  ) {
    super(TRANSACTION_STAGE.work, cause, workError);
    this.message =
      `сессия advisory-лока ${lock} разорвана во время работы: сервер снял лок, и другая сессия могла ` +
      `взять его до конца работы — взаимное исключение нарушено (${safeText(cause)})`;
  }
}
