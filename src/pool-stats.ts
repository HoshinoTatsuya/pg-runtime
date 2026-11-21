import { isPool } from './is-pool';
import { poolOf } from './pool-of';
import type { PoolDatabase } from './types/pool-database.type';
import type { PoolStats } from './types/pool-stats.type';

/**
 * Снимок пула для метрик: всего, свободно, выдано, ждут соединения. Рост
 * `waiting` при малом `inUse` невозможен — при `inUse === total` и растущем
 * `waiting` предел задаёт пул, а не база.
 */
export function poolStats(target: PoolDatabase | object): PoolStats {
  const pool = poolOf(target);
  if (!isPool(pool)) {
    throw new Error('poolStats: ожидается пул pg или база drizzle над ним');
  }
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    inUse: pool.totalCount - pool.idleCount,
    waiting: pool.waitingCount,
  };
}
