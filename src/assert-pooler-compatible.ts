import { isPool } from './is-pool';
import { poolOf } from './pool-of';
import { PoolerIncompatibleError } from './pooler-incompatible.error';
import { startupParametersOf } from './startup-parameters-of';
import type { PoolDatabase } from './types/pool-database.type';

/**
 * Проверка на старте: настройки пула совместимы с пулером в transaction mode.
 * Отказ — `PoolerIncompatibleError` со списком. Потолки транзакции под пулером —
 * опции транзакции (`set_config(…, true)`), а не параметры соединения.
 * Параметры ищутся там же, где их берёт pg: опции пула, строка подключения
 * (разбором самого pg), окружение процесса (`PGOPTIONS`) и `pg.defaults`.
 * Проверено против подделки пула, НЕ против настоящего PgBouncer.
 */
export function assertPoolerCompatible(target: PoolDatabase | object): void {
  const pool = poolOf(target);
  if (!isPool(pool)) {
    throw new Error('assertPoolerCompatible: ожидается пул pg или база drizzle над ним');
  }
  const config = (pool as unknown as { options?: Record<string, unknown> }).options ?? {};
  const sources = startupParametersOf(config);
  const problems: string[] = [];
  for (const name of sources.pool) {
    problems.push(`параметр пула ${name} уходит параметром старта сессии`);
  }
  if (sources.connectionString === null) {
    problems.push('строка подключения не разобрана драйвером — параметры старта сессии не проверить');
  }
  for (const name of sources.connectionString ?? []) {
    problems.push(`параметр ${name} в строке подключения уходит параметром старта сессии`);
  }
  const named = new Set([...sources.pool, ...(sources.connectionString ?? [])]);
  for (const name of sources.effective.filter((parameter) => !named.has(parameter))) {
    problems.push(
      `параметр ${name} приходит из ${name === 'options' ? 'окружения процесса (PGOPTIONS) или ' : ''}pg.defaults ` +
        'и уходит параметром старта сессии',
    );
  }
  if (problems.length > 0) {
    throw new PoolerIncompatibleError(problems);
  }
}
