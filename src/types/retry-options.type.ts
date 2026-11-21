import type { RetryReason } from './retry-reason.type';
import type { TransactionStage } from './transaction-stage.type';

/** Повтор ВСЕЙ транзакции (опция `retry`). */
export interface RetryOptions {
  /** Всего попыток, целое ≥ 1. */
  readonly attempts: number;
  /** База паузы `backoffMs × 2^(попытка−1)` с full jitter; по умолчанию 25 мс. */
  readonly backoffMs?: number;
  /**
   * Причины повтора; по умолчанию `[serialization, deadlock]`. Пустой список —
   * отказ: повтор, включённый без единой причины, ничего бы не повторял молча.
   */
  readonly on?: readonly RetryReason[];
  /**
   * Своя классификация сверх `on`: `true` — повторить. Получает отказ (до
   * `wrapFailure` — исходный) и стадию. Отказ после отмены (`signal`)
   * не повторяется никогда, исход COMMIT неизвестен — тоже.
   */
  readonly when?: (error: unknown, stage: TransactionStage) => boolean;
}
