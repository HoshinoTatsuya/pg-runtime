import type { RetryReason } from '../types/retry-reason.type';
import { RETRY_REASON } from './retry-reason.constant';

/** Причины повтора, когда `retry.on` не задан: как до 0.6.0. */
export const DEFAULT_RETRY_REASONS: readonly RetryReason[] = [
  RETRY_REASON.serialization,
  RETRY_REASON.deadlock,
];
