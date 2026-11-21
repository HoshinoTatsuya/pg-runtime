import { CLIENT_MISUSE } from './constants/client-misuse.constant';
import type { ClientMisuse } from './types/client-misuse.type';

const MESSAGE: Record<ClientMisuse, string> = {
  [CLIENT_MISUSE.release]:
    'client.release() внутри работы: соединение вернулось бы в пул посреди транзакции, и следующий вызывающий писал бы в неё; соединение возвращает пакет (transactionKeepingFailure, withSessionAdvisoryLock)',
  [CLIENT_MISUSE.afterEnd]:
    'запрос через соединение транзакции после её конца: соединение уже в пуле и может принадлежать другому вызывающему',
  [CLIENT_MISUSE.end]:
    'client.end() внутри работы: соединение закрылось бы посреди транзакции (или сессии лока) мимо пула, и исход COMMIT читался бы как неизвестный; соединение закрывает и возвращает пакет',
};

/**
 * Работа распорядилась соединением транзакции так, что его получил бы чужой
 * вызывающий. Бросается ДО обращения к пулу и к базе: соединение остаётся
 * за транзакцией.
 */
export class TransactionClientMisuseError extends Error {
  public override readonly name = 'TransactionClientMisuseError';

  public constructor(public readonly misuse: ClientMisuse) {
    super(MESSAGE[misuse]);
  }
}
