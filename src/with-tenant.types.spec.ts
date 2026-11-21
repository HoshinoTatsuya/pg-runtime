import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { NodePgDatabase, NodePgTransaction } from 'drizzle-orm/node-postgres';

import { withTenant } from './with-tenant';

/**
 * Контракт типов `withTenant` — его проверяет `pnpm typecheck` (tsc по src
 * вместе со спеками); тела функций не вызываются.
 */
describe('withTenant: типы', () => {
  type AppTransaction = NodePgTransaction<
    Record<string, never>,
    ExtractTablesWithRelations<Record<string, never>>
  >;

  it('транзакция drizzle принимается', () => {
    const call = (tx: AppTransaction): Promise<void> => withTenant(tx, 't1');
    expect(call).toBeInstanceOf(Function);
  });

  it('корневой клиент вместо транзакции — ошибка компиляции', () => {
    // @ts-expect-error — у корневого клиента нет rollback: контекст на транзакцию ему не задать
    const call = (db: NodePgDatabase): Promise<void> => withTenant(db, 't1');
    expect(call).toBeInstanceOf(Function);
  });
});
