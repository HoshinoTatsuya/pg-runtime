import { deepFreeze } from '../deep-freeze';

/**
 * Что делать с `transactionKeepingFailure`, вызванным ВНУТРИ работы другой
 * транзакции того же пула. Внешний вызов держит соединение, внутренний ждал бы
 * второе: при `max` параллельных внешних вызовах это взаимная блокировка пула
 * (`connectionTimeoutMillis` по умолчанию 0 — ждать вечно).
 */
export const NESTED_TRANSACTION = {
  /** По умолчанию: отказ `NestedTransactionError` до обращения к пулу. */
  refuse: 'refuse',
  /** Точка сохранения во внешней транзакции (`SAVEPOINT`): откат вложенной не трогает внешнюю. */
  savepoint: 'savepoint',
} as const;

deepFreeze(NESTED_TRANSACTION);
