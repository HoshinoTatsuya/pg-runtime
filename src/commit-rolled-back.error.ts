/**
 * COMMIT, на который сервер ответил тегом ROLLBACK: транзакцию прервал отказ
 * запроса, который работа перехватила и вернула «успех». Записано НИЧЕГО —
 * результат работы вызывающему отдавать нельзя.
 */
export class CommitRolledBackError extends Error {
  public override readonly name = 'CommitRolledBackError';

  public constructor() {
    super(
      'COMMIT ответил ROLLBACK: транзакция была прервана отказом запроса, который работа перехватила; не записано ничего',
    );
  }
}
