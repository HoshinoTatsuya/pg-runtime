/**
 * Запрос или настройка, которые ломаются под пулером в transaction mode
 * (PgBouncer, Odyssey): сессионное состояние (`SET` без LOCAL, `LISTEN`,
 * сессионный advisory-лок, курсор WITH HOLD) остаётся на серверном соединении,
 * которое следующая транзакция получит у другого клиента, а именованный
 * подготовленный оператор — на соединении, до которого следующий запрос не
 * дойдёт. Бросается ДО отправки в базу; что именно — в `problems`.
 */
export class PoolerIncompatibleError extends Error {
  public override readonly name = 'PoolerIncompatibleError';

  public constructor(public readonly problems: readonly string[]) {
    super(`несовместимо с пулером в transaction mode: ${problems.join('; ')}`);
  }
}
