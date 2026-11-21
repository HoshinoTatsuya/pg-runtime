import { deepFreeze } from '../deep-freeze';

/**
 * Пределы параметров Postgres. Потолки `lock_timeout`, `statement_timeout`,
 * `idle_in_transaction_session_timeout` — int4 в мс (`pg_settings.max_val`
 * 2147483647, ~24.8 суток): больше — отказ 22023 «Value exceeds integer
 * range», причём уже после BEGIN, на стадии работы. Проверяется до обращения к базе.
 */
export const POSTGRES_LIMIT = {
  MAX_TIMEOUT_MS: 2_147_483_647,
} as const;

deepFreeze(POSTGRES_LIMIT);
