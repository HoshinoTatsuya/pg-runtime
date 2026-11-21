import type { NESTED_TRANSACTION } from '../constants/nested-transaction.constant';

export type NestedTransaction = (typeof NESTED_TRANSACTION)[keyof typeof NESTED_TRANSACTION];
