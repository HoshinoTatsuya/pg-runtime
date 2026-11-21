import { deepFreeze } from '../deep-freeze';

/** Уровни изоляции транзакции — значениями, а не строкой от вызывающего (она ушла бы в SQL). */
export const ISOLATION_LEVEL = {
  readCommitted: 'READ COMMITTED',
  repeatableRead: 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
} as const;

deepFreeze(ISOLATION_LEVEL);
