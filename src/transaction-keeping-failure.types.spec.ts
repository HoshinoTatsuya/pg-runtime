import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { NodePgDatabase, NodePgTransaction } from 'drizzle-orm/node-postgres';
import { integer, pgTable } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';

import { transactionKeepingFailure } from './transaction-keeping-failure';

/**
 * Контракт типов — его проверяет `pnpm typecheck` (tsc по src, вместе со
 * спеками); jest здесь только транспилирует. Тела функций не вызываются.
 */
describe('transactionKeepingFailure: типы', () => {
  type AppDatabase = NodePgDatabase & { $client: Pool };
  /** Тип транзакции, объявленный ПРОЕКТОМ (`AppTransaction` потребителя). */
  type AppTransaction = NodePgTransaction<
    Record<string, never>,
    ExtractTablesWithRelations<Record<string, never>>
  >;

  it('работа с транзакцией проекта принимается, результат работы — результат вызова', () => {
    const call = (db: AppDatabase): Promise<number> =>
      transactionKeepingFailure(db, async (tx: AppTransaction) => {
        void tx;
        return 1;
      });
    expect(call).toBeInstanceOf(Function);
  });

  it('работа без аннотации получает транзакцию базы потребителя: его таблица принимается, tx — не any', () => {
    const counters = pgTable('counters', { value: integer('value').notNull() });
    const call = (db: AppDatabase): Promise<void> =>
      transactionKeepingFailure(db, async (tx) => {
        await tx.insert(counters).values({ value: 1 });
        // @ts-expect-error — tx выведен из базы, а не any: несуществующего метода нет
        tx.noSuchMethod();
      });
    expect(call).toBeInstanceOf(Function);
  });

  it('работа, ждущая корневой клиент вместо транзакции, — ошибка компиляции', () => {
    const call = (db: AppDatabase): Promise<unknown> =>
      // @ts-expect-error — у корневого клиента нет rollback(): запись ушла бы мимо транзакции
      transactionKeepingFailure(db, async (root: AppDatabase) => root);
    expect(call).toBeInstanceOf(Function);
  });
});
