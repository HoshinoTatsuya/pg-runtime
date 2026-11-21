/**
 * `transactionKeepingFailure` вызван внутри работы другой транзакции того же
 * пула. Внешний вызов держит соединение, внутренний ждал бы второе: при `max`
 * параллельных внешних вызовах пул встаёт навсегда. Бросается ДО обращения к
 * пулу. Нужна вложенная транзакция — `tx.transaction(...)` внешней или опция
 * `nested: NESTED_TRANSACTION.savepoint`; нужна независимая — вызов вне работы.
 * Тот же отказ — `withSessionAdvisoryLock` внутри работы транзакции того же
 * пула: ему тоже нужно второе соединение.
 */
export class NestedTransactionError extends Error {
  public override readonly name = 'NestedTransactionError';

  /** `message` — свой текст для вызова, которому нужно своё соединение (`withSessionAdvisoryLock`). */
  public constructor(
    message: string = 'transactionKeepingFailure внутри работы транзакции того же пула: внутренний вызов ждал бы второе ' +
      'соединение, пока внешний держит первое, — взаимная блокировка пула. Вложенная транзакция — ' +
      'tx.transaction(...) или опция nested: NESTED_TRANSACTION.savepoint; независимая — вызов вне работы',
  ) {
    super(message);
  }
}
