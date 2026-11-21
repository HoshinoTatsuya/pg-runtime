import type { Pool } from 'pg';

/**
 * Пул pg — по форме (`connect`, `totalCount`, `idleCount`), а не
 * `instanceof Pool`: при двух копиях pg в монорепозитории (пакет и сервис)
 * класс у пула другой, и честный пул отвергался бы. Клиент (`Client`) формы
 * пула не имеет: у него нет счётчиков.
 */
export function isPool(value: unknown): value is Pool {
  const candidate = value as { connect?: unknown; totalCount?: unknown; idleCount?: unknown } | null;
  return (
    candidate !== null &&
    typeof candidate === 'object' &&
    typeof candidate.connect === 'function' &&
    typeof candidate.totalCount === 'number' &&
    typeof candidate.idleCount === 'number'
  );
}
