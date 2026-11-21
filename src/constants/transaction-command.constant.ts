import { deepFreeze } from '../deep-freeze';

/** Команды управления транзакцией; `rollback` — ещё и тег ответа COMMIT прерванной транзакции. */
export const TRANSACTION_COMMAND = {
  begin: 'BEGIN',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
} as const;

deepFreeze(TRANSACTION_COMMAND);
