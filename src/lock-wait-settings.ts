import { TRANSACTION_DEFAULTS } from './constants/transaction-defaults.constant';
import { positiveInt } from './positive-int';
import { timeoutMs } from './timeout-ms';
import type { AdvisoryLockOptions } from './types/advisory-lock-options.type';

/** Потолок и интервал опроса advisory-лока — проверенные до соединения. */
export function lockWaitSettings(options: AdvisoryLockOptions): { timeoutMs: number; pollMs: number } {
  const ceiling = timeoutMs('timeoutMs', options.timeoutMs);
  if (ceiling === undefined) {
    throw new Error('withAdvisoryLock: timeoutMs обязателен — ожидание лока без потолка висело бы вечно');
  }
  const pollMs = positiveInt('pollMs', options.pollMs) ?? TRANSACTION_DEFAULTS.ADVISORY_LOCK_POLL_MS;
  return { timeoutMs: ceiling, pollMs };
}
