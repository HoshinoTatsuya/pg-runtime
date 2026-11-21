import type { RETRY_REASON } from '../constants/retry-reason.constant';

export type RetryReason = (typeof RETRY_REASON)[keyof typeof RETRY_REASON];
