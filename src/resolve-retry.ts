import { DEFAULT_RETRY_REASONS } from './constants/default-retry-reasons.constant';
import { RETRY_REASON } from './constants/retry-reason.constant';
import { positiveInt } from './positive-int';
import type { ResolvedRetry } from './types/resolved-retry.type';
import type { RetryOptions } from './types/retry-options.type';

/** Проверка `retry` до соединения; без опции — одна попытка. */
export function resolveRetry(retry: RetryOptions | undefined): ResolvedRetry {
  if (retry === undefined) {
    return { attempts: 1, backoffMs: undefined, reasons: new Set(), when: undefined };
  }
  const attempts = positiveInt('retry.attempts', retry.attempts) ?? 1;
  if (retry.backoffMs !== undefined && (!Number.isFinite(retry.backoffMs) || retry.backoffMs < 0)) {
    throw new Error(
      `transactionKeepingFailure: retry.backoffMs — неотрицательное число, получено ${retry.backoffMs}`,
    );
  }
  const reasons = retry.on ?? DEFAULT_RETRY_REASONS;
  const known = new Set<string>(Object.values(RETRY_REASON));
  const unknown = reasons.filter((reason) => !known.has(reason));
  if (unknown.length > 0) {
    throw new Error(`transactionKeepingFailure: retry.on — неизвестные причины ${unknown.join(', ')}`);
  }
  if (reasons.length === 0 && retry.when === undefined) {
    throw new Error('transactionKeepingFailure: retry.on пуст и retry.when не задан — повторять нечего');
  }
  if (retry.when !== undefined && typeof retry.when !== 'function') {
    throw new Error('transactionKeepingFailure: retry.when — функция');
  }
  return { attempts, backoffMs: retry.backoffMs, reasons: new Set(reasons), when: retry.when };
}
