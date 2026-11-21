import type { RetryReason } from './retry-reason.type';
import type { TransactionStage } from './transaction-stage.type';

/** Проверенные настройки повтора. */
export interface ResolvedRetry {
  readonly attempts: number;
  readonly backoffMs: number | undefined;
  readonly reasons: ReadonlySet<RetryReason>;
  readonly when: ((error: unknown, stage: TransactionStage) => boolean) | undefined;
}
