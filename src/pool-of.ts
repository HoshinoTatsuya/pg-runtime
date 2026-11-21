import { isPool } from './is-pool';

/**
 * Пул из аргумента «пул pg или drizzle над ним» (`drizzle(pool)` кладёт пул в
 * `$client`). `null`/`undefined` и что угодно без пула — `undefined`, а не
 * TypeError чтения `$client`: вызывающий отказывает своим понятным текстом.
 */
export function poolOf(target: unknown): unknown {
  return isPool(target) ? target : (target as { $client?: unknown } | null | undefined)?.$client;
}
