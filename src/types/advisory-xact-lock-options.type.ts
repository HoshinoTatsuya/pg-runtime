import type { AdvisoryLockOptions } from './advisory-lock-options.type';
import type { TransactionOptions } from './transaction-options.type';

/** Опции `withAdvisoryLock`: потолок лока и опции транзакции, в которой идёт работа. */
export type AdvisoryXactLockOptions = AdvisoryLockOptions & Omit<TransactionOptions, 'signal' | 'nested'>;
