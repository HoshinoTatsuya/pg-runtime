import { deepFreeze } from '../deep-freeze';

/**
 * Что работа сделала с соединением транзакции не так. Значение — в поле
 * `misuse` у `TransactionClientMisuseError`: вызывающий сравнивает с константой,
 * а не со строкой.
 */
export const CLIENT_MISUSE = {
  /** `client.release()` внутри работы: соединение ушло бы в пул посреди транзакции. */
  release: 'release',
  /** Запрос через соединение после конца транзакции: оно уже у другого вызывающего. */
  afterEnd: 'after-end',
  /** `client.end()` внутри работы: соединение закрылось бы посреди транзакции мимо пула. */
  end: 'end',
} as const;

deepFreeze(CLIENT_MISUSE);
