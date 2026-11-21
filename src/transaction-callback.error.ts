import { safeText } from './safe-text';

/**
 * Колбэк опции транзакции (`retry.when`, `wrapFailure`) бросил, разбирая
 * отказ попытки. Наружу — этот отказ: исходный отказ попытки в `cause`
 * (разбор начинается с того, ЧТО упало, а не с ошибки колбэка), отказ колбэка —
 * в `callbackError`. Попытка не повторяется: решение о повторе не принято.
 */
export class TransactionCallbackError extends Error {
  public override readonly name = 'TransactionCallbackError';

  public constructor(
    public readonly callback: 'retry.when' | 'wrapFailure',
    public readonly callbackError: unknown,
    failure: unknown,
  ) {
    super(`${callback} бросил (${safeText(callbackError)}), разбирая отказ: ${safeText(failure)}`, {
      cause: failure,
    });
  }
}
