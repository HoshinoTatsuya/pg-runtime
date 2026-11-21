import type { RetryReason } from '../types/retry-reason.type';
import { RETRY_REASON } from './retry-reason.constant';

/** SQLSTATE причин повтора, которые узнаются по коду ошибки. */
export const RETRY_REASON_SQLSTATE: Readonly<Partial<Record<RetryReason, string>>> = Object.freeze({
  [RETRY_REASON.serialization]: '40001',
  [RETRY_REASON.deadlock]: '40P01',
  [RETRY_REASON.lockTimeout]: '55P03',
});
