import type { TransactionOptions } from '../types/transaction-options.type';

/** Опции уровня транзакции: под точкой сохранения они принадлежат внешней. */
export const OUTER_ONLY_OPTIONS = [
  'isolationLevel',
  'readOnly',
  'deferrable',
  'lockTimeoutMs',
  'statementTimeoutMs',
  'idleInTransactionTimeoutMs',
  'retry',
  'localSettings',
  'resetAppSettings',
  'resetSession',
  'sessionBaseline',
  'rollbackTimeoutMs',
  'sessionStateCheck',
] as const satisfies readonly (keyof TransactionOptions)[];
