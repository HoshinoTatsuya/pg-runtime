import { TRANSACTION_CONTEXT } from './transaction-context';
import type { TransactionFrame } from './types/transaction-frame.type';

/** Самая внутренняя незавершённая транзакция этого пула, в работе которой идёт вызов. */
export function activeFrame(pool: object): TransactionFrame | undefined {
  const frames = TRANSACTION_CONTEXT.getStore() ?? [];
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (frame !== undefined && frame.pool === pool && !frame.ended) {
      return frame;
    }
  }
  return undefined;
}
