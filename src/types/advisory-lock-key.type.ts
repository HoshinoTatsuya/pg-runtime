/**
 * Ключ advisory-лока: целое (int8, `number` — безопасное целое) или строка
 * (`hashtextextended(ключ, 0)` — 64 бита).
 */
export type AdvisoryLockKey = number | bigint | string;
