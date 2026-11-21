import { safeText } from './safe-text';

/**
 * Работа `withSessionAdvisoryLock` вернулась (успехом или отказом), оставив на
 * соединении лока открытую транзакцию: `BEGIN` без `COMMIT`/`ROLLBACK` или
 * транзакцию, прерванную отказом запроса. Её изменения НЕ зафиксированы:
 * соединение уничтожено, сервер откатил транзакцию и снял лок вместе с
 * сессией. Без этого соединение ушло бы в пул в состоянии «idle in
 * transaction», и следующий владелец писал бы внутри чужой транзакции.
 * Отказ самой работы, если был, — в `cause`.
 */
export class TransactionLeftOpenError extends Error {
  public override readonly name = 'TransactionLeftOpenError';

  public constructor(
    public readonly lock: string,
    workError?: unknown,
  ) {
    super(
      `работа под сессионным advisory-локом ${lock} оставила открытую транзакцию: её изменения не ` +
        'зафиксированы — соединение уничтожено, сервер откатил транзакцию и снял лок вместе с сессией' +
        (workError === undefined ? '' : ` (отказ работы: ${safeText(workError)})`),
      workError === undefined ? undefined : { cause: workError },
    );
  }
}
