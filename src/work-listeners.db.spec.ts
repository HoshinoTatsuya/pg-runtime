import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';

import { NESTED_TRANSACTION } from './constants/nested-transaction.constant';
import { createTestDatabase } from './testing/test-database';
import { transactionKeepingFailure } from './transaction-keeping-failure';
import { withSessionAdvisoryLock } from './with-session-advisory-lock';

const adminUrl = process.env.PG_TEST_URL;
const describeDb = adminUrl ? describe : describe.skip;

/**
 * Слушатели, которые работа поставила на выданное ей соединение и не сняла,
 * снимаются с концом работы: соединение возвращается в пул и уходит следующему
 * владельцу, и замыкание прошлой работы не должно получать его события (и не
 * должно копиться до MaxListenersExceededWarning). Слушатели пакета и пула —
 * не трогаются.
 */
describeDb('слушатели работы снимаются с концом работы [нужен PG_TEST_URL]', () => {
  let database: { url: string; drop(): Promise<void> };

  beforeAll(async () => {
    database = await createTestDatabase(adminUrl as string, []);
  });
  afterAll(async () => {
    await database?.drop();
  });

  const EVENTS = ['notice', 'error', 'end', 'notification'] as const;
  const counts = (client: PoolClient): number[] => EVENTS.map((event) => client.listenerCount(event));
  /** Работа ставит по слушателю на каждое событие, разными методами, и не снимает. */
  const leave = (client: PoolClient, heard: string[]): void => {
    client.on('notice', () => heard.push('notice'));
    client.addListener('error', () => heard.push('error'));
    client.once('end', () => heard.push('end'));
    client.prependListener('notification', () => heard.push('notification'));
  };

  const withPool = async (
    run: (pool: Pool, connection: () => PoolClient) => Promise<void>,
  ): Promise<void> => {
    const pool = new Pool({ connectionString: database.url, max: 1 });
    let connection: PoolClient | undefined;
    pool.on('connect', (client: PoolClient) => {
      connection = client;
    });
    try {
      await run(pool, () => connection as PoolClient);
    } finally {
      await pool.end();
    }
  };

  it.each([
    ['вернулась', false],
    ['бросила', true],
  ])(
    'transactionKeepingFailure: работа %s — её слушатели сняты, слушатели пакета на месте',
    async (_label, fails) => {
      await withPool(async (pool, connection) => {
        await transactionKeepingFailure(drizzle(pool), async () => undefined);
        const baseline = counts(connection());
        const heard: string[] = [];
        await transactionKeepingFailure(drizzle(pool), async (_tx, client) => {
          leave(client, heard);
          expect(counts(connection())).toEqual(baseline.map((count) => count + 1));
          if (fails) {
            throw new Error('отказ работы');
          }
        }).catch(() => undefined);
        expect(pool.totalCount).toBe(1);
        expect(counts(connection())).toEqual(baseline);
        connection().emit('notice', { message: 'чужой' });
        expect(heard).toEqual([]);
      });
    },
  );

  it('точка сохранения: слушатели вложенной работы сняты с её концом, внешней — с концом внешней', async () => {
    await withPool(async (pool, connection) => {
      await transactionKeepingFailure(drizzle(pool), async () => undefined);
      const baseline = counts(connection());
      const heard: string[] = [];
      const db = drizzle(pool);
      await transactionKeepingFailure(db, async (_tx, outer) => {
        outer.on('notice', () => heard.push('outer'));
        await transactionKeepingFailure(
          db,
          async (_inner, client) => {
            leave(client, heard);
          },
          { nested: NESTED_TRANSACTION.savepoint },
        );
        // Вложенная кончилась: её слушатели сняты, у внешней свой остался.
        expect(counts(connection())).toEqual(
          baseline.map((count, index) => (index === 0 ? count + 1 : count)),
        );
      });
      expect(counts(connection())).toEqual(baseline);
    });
  });

  it('withSessionAdvisoryLock: слушатели работы сняты, соединение в пуле', async () => {
    await withPool(async (pool, connection) => {
      await withSessionAdvisoryLock(pool, 'work-listeners', async () => undefined, { timeoutMs: 1_000 });
      const baseline = counts(connection());
      const heard: string[] = [];
      await withSessionAdvisoryLock(
        pool,
        'work-listeners',
        async (client) => {
          leave(client, heard);
        },
        { timeoutMs: 1_000 },
      );
      expect(pool.totalCount).toBe(1);
      expect(counts(connection())).toEqual(baseline);
      connection().emit('notice', { message: 'чужой' });
      expect(heard).toEqual([]);
    });
  });
});
