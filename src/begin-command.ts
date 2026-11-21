import { ISOLATION_LEVEL } from './constants/isolation-level.constant';
import { TRANSACTION_COMMAND } from './constants/transaction-command.constant';
import { safeText } from './safe-text';
import type { TransactionOptions } from './types/transaction-options.type';

/** BEGIN с уровнем изоляции и режимом — значениями из словаря, а не строкой вызывающего (она ушла бы в SQL). */
export function beginCommand(options: TransactionOptions): string {
  const parts: string[] = [TRANSACTION_COMMAND.begin];
  if (options.isolationLevel !== undefined) {
    if (!Object.values(ISOLATION_LEVEL).includes(options.isolationLevel)) {
      throw new Error(
        `transactionKeepingFailure: неизвестный уровень изоляции ${safeText(options.isolationLevel)}`,
      );
    }
    parts.push(`ISOLATION LEVEL ${options.isolationLevel}`);
  }
  if (options.readOnly === true) {
    parts.push('READ ONLY');
  }
  if (options.deferrable === true) {
    parts.push('DEFERRABLE');
  }
  return parts.join(' ');
}
