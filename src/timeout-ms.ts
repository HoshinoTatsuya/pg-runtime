import { POSTGRES_LIMIT } from './constants/postgres-limit.constant';
import { positiveInt } from './positive-int';

/**
 * Потолок транзакции: целое > 0 и не больше int4 Postgres. Больше — отказ
 * сервера 22023 уже после BEGIN, на каждом вызове и со стадией `work`, как
 * будто упала работа; здесь — до соединения и с именем опции.
 */
export function timeoutMs(name: string, value: number | undefined): number | undefined {
  const checked = positiveInt(name, value);
  if (checked !== undefined && checked > POSTGRES_LIMIT.MAX_TIMEOUT_MS) {
    throw new Error(
      `transactionKeepingFailure: ${name} — не больше ${POSTGRES_LIMIT.MAX_TIMEOUT_MS} (int4 мс у Postgres), получено ${checked}`,
    );
  }
  return checked;
}
