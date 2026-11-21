import { TIMER_LIMIT } from './constants/timer-limit.constant';
import { TRANSACTION_RETRY_DEFAULTS } from './constants/transaction-retry-defaults.constant';

/**
 * Пауза перед повтором попытки `attempt` (с 1): `backoffMs × 2^(попытка−1)`,
 * случайная доля от нуля до неё (full jitter), не выше потолка таймера. Без
 * `backoffMs` — `TRANSACTION_RETRY_DEFAULTS.BACKOFF_MS`, а не ноль: deadlock,
 * повторённый немедленно, встречает того же соперника в том же порядке.
 */
export function retryDelayMs(attempt: number, backoffMs: number | undefined, random: () => number): number {
  const base = backoffMs ?? TRANSACTION_RETRY_DEFAULTS.BACKOFF_MS;
  // Потолок — до доли: при attempt ≥ 1025 степень двойки — Infinity, и
  // 0 × Infinity дал бы NaN (доля 0 или база 0), а не паузу.
  const ceiling = base === 0 ? 0 : Math.min(TIMER_LIMIT.MAX_DELAY_MS, base * 2 ** (attempt - 1));
  return random() * ceiling;
}
