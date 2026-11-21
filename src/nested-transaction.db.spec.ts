import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { CLIENT_MISUSE } from './constants/client-misuse.constant';
import { NESTED_TRANSACTION } from './constants/nested-transaction.constant';
import { errorChain } from './error-chain';
import { NestedTransactionError } from './nested-transaction.error';
import { createTestDatabase } from './testing/test-database';
import { withinSeconds } from './testing/within-seconds';
import { TransactionClientMisuseError } from './transaction-client-misuse.error';
import { transactionKeepingFailure } from './transaction-keeping-failure';

const adminUrl = process.env.PG_TEST_URL;
const describeDb = adminUrl ? describe : describe.skip;

/**
 * Вложенный вызов внутри работы: внешний держит соединение, внутренний ждал
 * бы второе. При пуле max=1 это зависание навсегда (`connectionTimeoutMillis`
 * по умолчанию 0) — поэтому каждый вызов под потолком: зависание = красный
 * с текстом, а не таймаут jest.
 */
describeDb('вложенный вызов transactionKeepingFailure [нужен PG_TEST_URL]', () => {
  let database: { url: string; drop(): Promise<void> };
  let pool: Pool;

  beforeAll(async () => {
    database = await createTestDatabase(adminUrl as string, ['CREATE TABLE nt (name text PRIMARY KEY)']);
    pool = new Pool({ connectionString: database.url, max: 1 });
  });
  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const names = async (like: string): Promise<string[]> =>
    (
      await pool.query<{ name: string }>('SELECT name FROM nt WHERE name LIKE $1 ORDER BY name', [like])
    ).rows.map((row) => row.name);

  it('по умолчанию — отказ NestedTransactionError, а не взаимная блокировка пула; внешняя откатана', async () => {
    const db = drizzle(pool);
    const outcome = transactionKeepingFailure(db, async (tx) => {
      await tx.execute(sql`INSERT INTO nt VALUES ('refuse.outer')`);
      await transactionKeepingFailure(db, async (inner) => {
        await inner.execute(sql`INSERT INTO nt VALUES ('refuse.inner')`);
      });
    });
    await expect(withinSeconds(5, outcome)).rejects.toBeInstanceOf(NestedTransactionError);
    expect(await names('refuse.%')).toEqual([]);
    expect(pool.totalCount - pool.idleCount).toBe(0);
  });

  it('вложенный через другую базу drizzle над тем же пулом — тоже отказ', async () => {
    const outcome = transactionKeepingFailure(drizzle(pool), async () =>
      transactionKeepingFailure(drizzle(pool), async () => 'внутри'),
    );
    await expect(withinSeconds(5, outcome)).rejects.toBeInstanceOf(NestedTransactionError);
  });

  it('savepoint: отказ вложенной откатывает только её, внешняя фиксируется', async () => {
    const db = drizzle(pool);
    await withinSeconds(
      5,
      transactionKeepingFailure(db, async (tx) => {
        await tx.execute(sql`INSERT INTO nt VALUES ('sp.outer')`);
        await transactionKeepingFailure(
          db,
          async (inner) => {
            await inner.execute(sql`INSERT INTO nt VALUES ('sp.inner')`);
            throw new Error('отказ вложенной');
          },
          { nested: NESTED_TRANSACTION.savepoint },
        ).catch(() => undefined);
        await transactionKeepingFailure(
          db,
          async (inner, client) => {
            await inner.execute(sql`INSERT INTO nt VALUES ('sp.kept')`);
            // Соединение вложенной — то же, что у внешней: тот же backend.
            const own = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
            const outer = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
            expect(own.rows[0]?.pid).toBe(outer.rows[0]?.pid);
          },
          { nested: NESTED_TRANSACTION.savepoint },
        );
      }),
    );
    expect(await names('sp.%')).toEqual(['sp.kept', 'sp.outer']);
  });

  it.each([
    ['сырой клиент', 'raw'],
    ['inner.execute (сессия drizzle вложенной)', 'drizzle'],
  ])(
    'savepoint: запрос откатившейся вложенной, переживший её (таймер), через %s — отказ, а не запись во внешнюю',
    async (_name, path) => {
      const db = drizzle(pool);
      const tag = `spl.${path}`;
      let late: Promise<unknown> | undefined;
      await withinSeconds(
        5,
        transactionKeepingFailure(db, async (tx) => {
          await tx.execute(sql`INSERT INTO nt VALUES (${`${tag}.outer`})`);
          await transactionKeepingFailure(
            db,
            async (inner, client) => {
              late = new Promise((resolve) => setTimeout(resolve, 100)).then(() =>
                path === 'raw'
                  ? client.query('INSERT INTO nt VALUES ($1)', [`${tag}.late`])
                  : inner.execute(sql`INSERT INTO nt VALUES (${`${tag}.late`})`),
              );
              throw new Error('отказ вложенной');
            },
            { nested: NESTED_TRANSACTION.savepoint },
          ).catch(() => undefined);
          // Внешняя ещё идёт, когда срабатывает таймер вложенной.
          await new Promise((resolve) => setTimeout(resolve, 300));
        }),
      );
      const failure = await (late as Promise<unknown>).catch((error: unknown) => error);
      const misuse = errorChain(failure).find((link) => link instanceof TransactionClientMisuseError);
      expect((misuse as TransactionClientMisuseError | undefined)?.misuse).toBe(CLIENT_MISUSE.afterEnd);
      expect(await names(`${tag}.%`)).toEqual([`${tag}.outer`]);
    },
  );

  it('savepoint: вложенная в вложенную — свои точки сохранения, откат внутренней не трогает среднюю', async () => {
    const db = drizzle(pool);
    const nested = { nested: NESTED_TRANSACTION.savepoint } as const;
    await withinSeconds(
      5,
      transactionKeepingFailure(db, async (tx) => {
        await tx.execute(sql`INSERT INTO nt VALUES ('spd.outer')`);
        await transactionKeepingFailure(
          db,
          async (middle) => {
            await middle.execute(sql`INSERT INTO nt VALUES ('spd.middle')`);
            await transactionKeepingFailure(
              db,
              async (inner) => {
                await inner.execute(sql`INSERT INTO nt VALUES ('spd.inner')`);
                throw new Error('отказ внутренней');
              },
              nested,
            ).catch(() => undefined);
            await middle.transaction(async (native) => {
              await native.execute(sql`INSERT INTO nt VALUES ('spd.native')`);
            });
          },
          nested,
        );
      }),
    );
    expect(await names('spd.%')).toEqual(['spd.middle', 'spd.native', 'spd.outer']);
  });

  it('savepoint: отказ внешней после вложенной откатывает всё', async () => {
    const db = drizzle(pool);
    const outcome = transactionKeepingFailure(db, async () => {
      await transactionKeepingFailure(
        db,
        async (inner) => {
          await inner.execute(sql`INSERT INTO nt VALUES ('spall.inner')`);
        },
        { nested: NESTED_TRANSACTION.savepoint },
      );
      throw new Error('отказ внешней');
    });
    await expect(withinSeconds(5, outcome)).rejects.toThrow('отказ внешней');
    expect(await names('spall.%')).toEqual([]);
  });

  it('savepoint с опциями уровня транзакции — отказ: они принадлежат внешней', async () => {
    const db = drizzle(pool);
    const outcome = transactionKeepingFailure(db, async () =>
      transactionKeepingFailure(db, async () => 'внутри', {
        nested: NESTED_TRANSACTION.savepoint,
        lockTimeoutMs: 100,
        retry: { attempts: 2 },
      }),
    );
    await expect(withinSeconds(5, outcome)).rejects.toThrow('lockTimeoutMs, retry');
  });

  it('вызов, переживший работу (таймер), — уже не вложенный: своя транзакция', async () => {
    const db = drizzle(pool);
    let later: Promise<string> | undefined;
    await withinSeconds(
      5,
      transactionKeepingFailure(db, async () => {
        later = new Promise<string>((resolve, reject) => {
          setTimeout(() => {
            transactionKeepingFailure(db, async (tx) => {
              await tx.execute(sql`INSERT INTO nt VALUES ('late.own')`);
              return 'своя';
            }).then(resolve, reject);
          }, 50);
        });
      }),
    );
    await expect(withinSeconds(5, later as Promise<string>)).resolves.toBe('своя');
    expect(await names('late.%')).toEqual(['late.own']);
  });

  it('другой пул внутри работы — не вложенный: независимая транзакция проходит', async () => {
    const other = new Pool({ connectionString: database.url, max: 1 });
    try {
      await withinSeconds(
        5,
        transactionKeepingFailure(drizzle(pool), async () => {
          await transactionKeepingFailure(drizzle(other), async (tx) => {
            await tx.execute(sql`INSERT INTO nt VALUES ('other.pool')`);
          });
        }),
      );
      expect(await names('other.%')).toEqual(['other.pool']);
    } finally {
      await other.end();
    }
  });

  it('nested с неизвестным значением — отказ до соединения', async () => {
    await expect(
      transactionKeepingFailure(drizzle(pool), async () => 'x', { nested: 'later' as never }),
    ).rejects.toThrow('nested — refuse | savepoint');
  });
});
