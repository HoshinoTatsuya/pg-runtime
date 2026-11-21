import { safeText } from './safe-text';

/**
 * Отмена пришла в паузе между повторами: новой попытки не будет. Отказ
 * последней попытки (40001, 40P01…) — в `cause`, причина отмены
 * (`signal.reason`) — в `reason`. Раньше наружу уходил только `signal.reason`,
 * и разбор начинался с «отменено» без того, ЧТО повторялось.
 */
export class TransactionRetryAbortedError extends Error {
  public override readonly name = 'TransactionRetryAbortedError';

  public constructor(
    public readonly reason: unknown,
    lastFailure: unknown,
  ) {
    super(`повтор транзакции отменён (${safeText(reason)}); ` + `последний отказ: ${safeText(lastFailure)}`, {
      cause: lastFailure,
    });
  }
}
