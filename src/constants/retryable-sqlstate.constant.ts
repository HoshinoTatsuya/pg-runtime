import { deepFreeze } from '../deep-freeze';

/** SQLSTATE, после которых транзакцию можно повторить целиком (опция `retry`). */
export const RETRYABLE_SQLSTATE = {
  serializationFailure: '40001',
  deadlockDetected: '40P01',
} as const;

deepFreeze(RETRYABLE_SQLSTATE);
