import { safeText } from './safe-text';

/**
 * COMMIT ушёл, а ответа нет: соединение оборвалось, пока сервер его выполнял
 * или отвечал. Транзакция МОГЛА зафиксироваться — повтор работы может задвоить
 * запись, а сообщение «не записано» — соврать. Вызывающий обязан проверить
 * исход по данным (идемпотентный ключ, чтение записанного) или повторить
 * идемпотентную работу. Исходный отказ — в `cause`.
 */
export class CommitOutcomeUnknownError extends Error {
  public override readonly name = 'CommitOutcomeUnknownError';

  public constructor(cause: unknown) {
    super(
      'исход COMMIT неизвестен: соединение оборвалось после отправки COMMIT — транзакция могла ' +
        `зафиксироваться (${safeText(cause)})`,
      { cause },
    );
  }
}
