import { AsyncLocalStorage } from 'node:async_hooks';

import type { TransactionFrame } from './types/transaction-frame.type';

/**
 * Транзакции, внутри работы которых исполняется код. По ним вложенный вызов
 * узнаёт, что пул уже держит его соединение. Один экземпляр на копию пакета:
 * две копии пакета в монорепозитории друг друга не видят — это известный предел.
 */
export const TRANSACTION_CONTEXT = new AsyncLocalStorage<readonly TransactionFrame[]>();
