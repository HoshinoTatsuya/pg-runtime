/**
 * Работа сама завершила транзакцию (`COMMIT`/`ROLLBACK` через `tx.execute` или
 * сырой клиент): наш COMMIT или ROLLBACK пришёл уже вне транзакции (сервер
 * ответил предупреждением 25P01). Часть изменений могла зафиксироваться
 * отдельно от остальных — результат работы вызывающему отдавать нельзя, а
 * повторять её — тем более (повтор задвоил бы зафиксированное). Работа после
 * своего COMMIT отказала — её отказ в `cause`.
 */
export class ManualTransactionControlError extends Error {
  public override readonly name = 'ManualTransactionControlError';

  public constructor(cause?: unknown) {
    super(
      'работа сама завершила транзакцию (COMMIT/ROLLBACK внутри работы): изменения могли зафиксироваться частично — управлять транзакцией внутри работы нельзя',
      cause === undefined ? undefined : { cause },
    );
  }
}
