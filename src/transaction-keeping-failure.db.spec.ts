import { randomUUID } from 'node:crypto';

import { type ExtractTablesWithRelations, relations, sql } from 'drizzle-orm';
import { drizzle, type NodePgTransaction } from 'drizzle-orm/node-postgres';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { Client, Pool, type PoolClient } from 'pg';

import { CommitOutcomeUnknownError } from './commit-outcome-unknown.error';
import { CommitRolledBackError } from './commit-rolled-back.error';
import { CLIENT_MISUSE } from './constants/client-misuse.constant';
import { ISOLATION_LEVEL } from './constants/isolation-level.constant';
import { POSTGRES_LIMIT } from './constants/postgres-limit.constant';
import { RETRY_REASON } from './constants/retry-reason.constant';
import { RETRYABLE_SQLSTATE } from './constants/retryable-sqlstate.constant';
import { ManualTransactionControlError } from './manual-transaction-control.error';
import { TransactionClientMisuseError } from './transaction-client-misuse.error';
import { transactionKeepingFailure } from './transaction-keeping-failure';
import { TransactionRetryAbortedError } from './transaction-retry-aborted.error';

const adminUrl = process.env.PG_TEST_URL;
const describeDb = adminUrl ? describe : describe.skip;

/**
 * Схема для реляционных запросов: колонка `fullName` без явного имени — её
 * имя в базе даёт только `casing: 'snake_case'` базы (`full_name`).
 */
const authors = pgTable('tkf_authors', { id: integer('id').primaryKey(), fullName: text() });
const books = pgTable('tkf_books', { id: integer('id').primaryKey(), authorId: integer('author_id') });
const authorsRelations = relations(authors, ({ many }) => ({ books: many(books) }));
const booksRelations = relations(books, ({ one }) => ({
  author: one(authors, { fields: [books.authorId], references: [authors.id] }),
}));
const relationalSchema = { authors, books, authorsRelations, booksRelations };
type RelationalTransaction = NodePgTransaction<
  typeof relationalSchema,
  ExtractTablesWithRelations<typeof relationalSchema>
>;

/** Отдельная база набора: создаётся от адреса суперпользователя PG_TEST_URL. */
const createDatabase = async (): Promise<{ url: string; drop(): Promise<void> }> => {
  const name = `t_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl as string);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
};

/**
 * На настоящем Postgres. Адрес — PG_TEST_URL (`pnpm test`
 * поднимает postgres:17 в docker); без адреса набор пропускается, и
 * jest-assert-no-skipped валит прогон. Отказы
 * BEGIN/COMMIT/ROLLBACK подставляются подменой `query` у клиента пула; пул
 * `max=1` делает утечку соединения видимой: следующий вызов повис бы.
 */
describeDb('transactionKeepingFailure [нужен PG_TEST_URL]', () => {
  let database: { url: string; drop(): Promise<void> };

  beforeAll(async () => {
    database = await createDatabase();
    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      await client.query('CREATE TABLE tkf (name text PRIMARY KEY)');
      await client.query('CREATE TABLE tkf_authors (id integer PRIMARY KEY, full_name text)');
      await client.query('CREATE TABLE tkf_books (id integer PRIMARY KEY, author_id integer)');
      await client.query("INSERT INTO tkf_authors VALUES (1, 'автор')");
      await client.query('INSERT INTO tkf_books VALUES (10, 1)');
    } finally {
      await client.end();
    }
  });
  afterAll(async () => {
    await database?.drop();
  });

  type Command = 'begin' | 'commit' | 'rollback';

  const poolFailing = (failures: Partial<Record<Command, Error>>, seen: string[] = []): Pool => {
    const pool = new Pool({ connectionString: database.url, max: 1 });
    pool.on('connect', (client: PoolClient) => {
      const original = client.query.bind(client) as (...args: unknown[]) => unknown;
      // biome-ignore lint/suspicious/noExplicitAny: подмена перегруженного метода драйвера
      (client as any).query = (...args: unknown[]): unknown => {
        const first = args[0] as string | { text?: string } | undefined;
        const text = (typeof first === 'string' ? first : (first?.text ?? '')).trim().toLowerCase();
        seen.push(text);
        const failure = failures[text as Command];
        return failure ? Promise.reject(failure) : original(...args);
      };
    });
    return pool;
  };
  const checkedOut = (pool: Pool): number => pool.totalCount - pool.idleCount;
  const withinSeconds = async <T>(seconds: number, work: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`не завершилось за ${seconds} с`)), seconds * 1000);
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
    }
  };
  const release = async (pool: Pool): Promise<void> => {
    await withinSeconds(5, pool.end()).catch(() => undefined);
  };
  const names = async (pool: Pool, like: string): Promise<string[]> =>
    (
      await pool.query<{ name: string }>('SELECT name FROM tkf WHERE name LIKE $1 ORDER BY name', [like])
    ).rows.map((row) => row.name);

  it('успех: изменения зафиксированы, соединение вернулось в пул', async () => {
    const pool = poolFailing({});
    try {
      await transactionKeepingFailure(drizzle(pool), async (tx) => {
        await tx.execute(sql`INSERT INTO tkf VALUES ('commit.ok')`);
      });
      expect(await names(pool, 'commit.%')).toEqual(['commit.ok']);
      expect(checkedOut(pool)).toBe(0);
    } finally {
      await release(pool);
    }
  });

  it('отказ работы: наружу он же, изменения откатаны, соединение вернулось в пул', async () => {
    const pool = poolFailing({});
    const failure = new Error('отказ внутри транзакции');
    try {
      await expect(
        transactionKeepingFailure(drizzle(pool), async (tx) => {
          await tx.execute(sql`INSERT INTO tkf VALUES ('rollback.x')`);
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(await names(pool, 'rollback.%')).toEqual([]);
      expect(checkedOut(pool)).toBe(0);
    } finally {
      await release(pool);
    }
  });

  it('отказ BEGIN: наружу он, соединение НЕ утекает — следующий вызов при max=1 не виснет', async () => {
    const beginFailure = Object.assign(new Error('BEGIN не прошёл'), { code: '08006' });
    const seen: string[] = [];
    const pool = poolFailing({ begin: beginFailure }, seen);
    try {
      await expect(transactionKeepingFailure(drizzle(pool), async () => 'не дошли')).rejects.toBe(
        beginFailure,
      );
      expect(checkedOut(pool)).toBe(0);
      // Транзакция не началась: ROLLBACK слать не во что, соединение уничтожено.
      expect(seen.filter((text) => text === 'rollback')).toEqual([]);
      expect(pool.idleCount).toBe(0);
      await expect(
        withinSeconds(
          5,
          transactionKeepingFailure(drizzle(pool), async () => 'не дошли'),
        ),
      ).rejects.toBe(beginFailure);
    } finally {
      await release(pool);
    }
  });

  it('отказ COMMIT без ответа сервера при отказе ROLLBACK: исход неизвестен, причина в cause, соединение уничтожено', async () => {
    const commitFailure = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
    });
    const pool = poolFailing({
      commit: commitFailure,
      rollback: new Error('not queryable'),
    });
    try {
      // Ответа сервера на COMMIT нет, и откат не подтвердил открытую
      // транзакцию: COMMIT мог быть выполнен — «упало» было бы враньём.
      const outcome = await transactionKeepingFailure(drizzle(pool), async (tx) => {
        await tx.execute(sql`select 1`);
      }).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(CommitOutcomeUnknownError);
      expect((outcome as Error).cause).toBe(commitFailure);
      expect(checkedOut(pool)).toBe(0);
      // Соединение с непрошедшим откатом не возвращается простаивать.
      expect(pool.idleCount).toBe(0);
    } finally {
      await release(pool);
    }
  });

  it('отказ COMMIT, после которого ROLLBACK прошёл: наружу отказ COMMIT, соединение возвращено исправным', async () => {
    // COMMIT не дошёл до сервера (отказ до отправки), откат подтвердил, что
    // транзакция была открыта: исход известен, соединение живо — уничтожать
    // его незачем, и пул не должен терять соединения на каждом таком отказе.
    const commitFailure = new Error('COMMIT не отправлен');
    const pool = poolFailing({ commit: commitFailure });
    let firstClient: PoolClient | undefined;
    pool.on('acquire', (client: PoolClient) => {
      firstClient ??= client;
    });
    try {
      await expect(
        transactionKeepingFailure(drizzle(pool), async (tx) => {
          await tx.execute(sql`INSERT INTO tkf VALUES ('commitfail.x')`);
        }),
      ).rejects.toBe(commitFailure);
      expect(pool.totalCount).toBe(1);
      expect(pool.idleCount).toBe(1);
      expect(await names(pool, 'commitfail.%')).toEqual([]);
      // То же соединение, а не новое.
      const again = await pool.connect();
      try {
        expect(again).toBe(firstClient);
      } finally {
        again.release();
      }
    } finally {
      await release(pool);
    }
  });

  it('слушатели notice и error не копятся на соединении пула', async () => {
    const pool = poolFailing({});
    let connection: PoolClient | undefined;
    pool.on('connect', (client: PoolClient) => {
      connection = client;
    });
    try {
      await transactionKeepingFailure(drizzle(pool), async () => undefined);
      const notices = connection?.listenerCount('notice');
      const errors = connection?.listenerCount('error');
      for (let index = 0; index < 5; index += 1) {
        await transactionKeepingFailure(drizzle(pool), async () => undefined);
        await transactionKeepingFailure(drizzle(pool), async () => {
          throw new Error('откат');
        }).catch(() => undefined);
      }
      expect(pool.totalCount).toBe(1);
      expect(connection?.listenerCount('notice')).toBe(notices);
      expect(connection?.listenerCount('error')).toBe(errors);
    } finally {
      await release(pool);
    }
  });

  it('отказ работы при отказе ROLLBACK: наружу отказ работы, соединение уничтожено', async () => {
    const workFailure = new Error('отказ внутри транзакции');
    const pool = poolFailing({ rollback: new Error('откат не прошёл') });
    try {
      await expect(
        transactionKeepingFailure(drizzle(pool), async () => {
          throw workFailure;
        }),
      ).rejects.toBe(workFailure);
      expect(checkedOut(pool)).toBe(0);
      expect(pool.idleCount).toBe(0);
    } finally {
      await release(pool);
    }
  });

  /**
   * Работа получает транзакцию Drizzle, а не клиента над соединением: у клиента
   * вложенный `tx.transaction(...)` выполнил бы BEGIN/COMMIT прямо во внешней
   * транзакции и зафиксировал бы её раньше срока.
   */
  it('вложенная транзакция — точка сохранения: отказ внешней работы после неё откатывает всё', async () => {
    const pool = poolFailing({});
    const failure = new Error('отказ после вложенной');
    try {
      await expect(
        transactionKeepingFailure(drizzle(pool), async (tx) => {
          await tx.execute(sql`INSERT INTO tkf VALUES ('nested-outer.before')`);
          await tx.transaction(async (nested) => {
            await nested.execute(sql`INSERT INTO tkf VALUES ('nested-outer.inner')`);
          });
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(await names(pool, 'nested-outer.%')).toEqual([]);
      expect(checkedOut(pool)).toBe(0);
    } finally {
      await release(pool);
    }
  });

  it('отказ ВНУТРИ вложенной, перехваченный работой, откатывает только её', async () => {
    const pool = poolFailing({});
    try {
      await transactionKeepingFailure(drizzle(pool), async (tx) => {
        await tx.execute(sql`INSERT INTO tkf VALUES ('nested-inner.before')`);
        await tx
          .transaction(async (nested) => {
            await nested.execute(sql`INSERT INTO tkf VALUES ('nested-inner.lost')`);
            throw new Error('отказ во вложенной');
          })
          .catch(() => undefined);
        await tx.execute(sql`INSERT INTO tkf VALUES ('nested-inner.after')`);
      });
      expect(await names(pool, 'nested-inner.%')).toEqual(['nested-inner.after', 'nested-inner.before']);
      expect(checkedOut(pool)).toBe(0);
    } finally {
      await release(pool);
    }
  });

  /**
   * Сырой SQL через соединение работы идёт в ТУ ЖЕ транзакцию: откатывается
   * вместе с ней и фиксируется вместе с ней.
   */
  it('соединение работы — та же транзакция: сырой SQL откатывается с отказом и фиксируется с успехом', async () => {
    const pool = poolFailing({});
    const failure = new Error('отказ после сырого SQL');
    try {
      await expect(
        transactionKeepingFailure(drizzle(pool), async (tx, client) => {
          await client.query('INSERT INTO tkf VALUES ($1)', ['raw.rolled-back']);
          await tx.execute(sql`INSERT INTO tkf VALUES ('raw.rolled-back-drizzle')`);
          throw failure;
        }),
      ).rejects.toBe(failure);
      await transactionKeepingFailure(drizzle(pool), async (_tx, client) => {
        await client.query('INSERT INTO tkf VALUES ($1)', ['raw.committed']);
      });

      expect(await names(pool, 'raw.%')).toEqual(['raw.committed']);
      expect(checkedOut(pool)).toBe(0);
    } finally {
      await release(pool);
    }
  });

  it('база не над пулом — отказ с причиной до любого обращения к базе', async () => {
    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      await expect(transactionKeepingFailure(drizzle(client), async () => 'не дошли')).rejects.toThrow(
        'база обязана быть над пулом pg',
      );
    } finally {
      await client.end();
    }
  });

  it('работа проглотила отказ запроса: COMMIT ответил ROLLBACK — наружу отказ, а не успех', async () => {
    const seen: string[] = [];
    const pool = poolFailing({}, seen);
    try {
      const outcome = await transactionKeepingFailure(drizzle(pool), async (tx) => {
        await tx.execute(sql`INSERT INTO tkf VALUES ('swallowed.before')`);
        await tx.execute(sql`select ${'not-a-uuid'}::uuid`).catch(() => undefined);
        return 'работа вернула успех';
      }).then(
        (resolved) => ({ resolved }),
        (rejected: unknown) => ({ rejected: (rejected as Error).message }),
      );

      expect(outcome).toEqual({
        rejected: new CommitRolledBackError().message,
      });
      // Транзакция уже закончилась: ROLLBACK вслед — только предупреждение.
      expect(seen.filter((text) => text === 'rollback')).toEqual([]);
      expect(pool.idleCount).toBe(1);
      expect(await names(pool, 'swallowed.%')).toEqual([]);
      expect(checkedOut(pool)).toBe(0);
    } finally {
      await release(pool);
    }
  });

  it('wrapFailure получает стадию и исходный отказ — для формы QueryFailedError проекта', async () => {
    const beginFailure = new Error('BEGIN не прошёл');
    const pool = poolFailing({ begin: beginFailure });
    const wrapped: Array<[string, unknown]> = [];
    try {
      await expect(
        transactionKeepingFailure(drizzle(pool), async () => 'не дошли', {
          wrapFailure: (stage, error) => {
            wrapped.push([stage, error]);
            return new Error(`[${stage}] ${(error as Error).message}`);
          },
        }),
      ).rejects.toThrow('[BEGIN] BEGIN не прошёл');
      expect(wrapped).toEqual([['BEGIN', beginFailure]]);
    } finally {
      await release(pool);
    }
  });

  const setting = async (client: PoolClient, name: string): Promise<string> =>
    (await client.query<{ value: string }>('SELECT current_setting($1) AS value', [name])).rows[0]?.value ??
    '';

  it('уровень изоляции и режим только чтения доходят до транзакции', async () => {
    const pool = poolFailing({});
    try {
      const inside = await transactionKeepingFailure(
        drizzle(pool),
        async (_tx, client) => [
          await setting(client, 'transaction_isolation'),
          await setting(client, 'transaction_read_only'),
          await setting(client, 'transaction_deferrable'),
        ],
        { isolationLevel: ISOLATION_LEVEL.serializable, readOnly: true, deferrable: true },
      );
      expect(inside).toEqual(['serializable', 'on', 'on']);
      await expect(
        transactionKeepingFailure(
          drizzle(pool),
          async (tx) => {
            await tx.execute(sql`INSERT INTO tkf VALUES ('readonly.x')`);
          },
          { readOnly: true },
        ),
      ).rejects.toMatchObject({ cause: { code: '25006' } });
      // По умолчанию — как раньше: уровень сервера, запись разрешена.
      const byDefault = await transactionKeepingFailure(drizzle(pool), async (_tx, client) => [
        await setting(client, 'transaction_isolation'),
        await setting(client, 'transaction_read_only'),
      ]);
      expect(byDefault).toEqual(['read committed', 'off']);
    } finally {
      await release(pool);
    }
  });

  it('таймауты действуют только внутри транзакции и не остаются на соединении пула; все — одним запросом', async () => {
    const seen: string[] = [];
    const pool = poolFailing({}, seen);
    try {
      const inside = await transactionKeepingFailure(
        drizzle(pool),
        async (_tx, client) => [
          await setting(client, 'lock_timeout'),
          await setting(client, 'statement_timeout'),
          await setting(client, 'idle_in_transaction_session_timeout'),
        ],
        { lockTimeoutMs: 150, statementTimeoutMs: 2000, idleInTransactionTimeoutMs: 3000 },
      );
      expect(inside).toEqual(['150ms', '2s', '3s']);
      // Цена таймаутов — одно обращение к базе, а не по одному на настройку.
      expect(seen.filter((text) => text.includes('set_config'))).toHaveLength(1);
      // max=1: то же соединение. SET без LOCAL уехал бы следующему вызывающему.
      const after = await transactionKeepingFailure(drizzle(pool), async (_tx, client) => [
        await setting(client, 'lock_timeout'),
        await setting(client, 'statement_timeout'),
        await setting(client, 'idle_in_transaction_session_timeout'),
      ]);
      expect(after).toEqual(['0', '0', '0']);
      await expect(
        transactionKeepingFailure(
          drizzle(pool),
          async (_tx, client) => {
            await client.query('SELECT pg_sleep(2)');
          },
          { statementTimeoutMs: 100 },
        ),
      ).rejects.toMatchObject({ code: '57014' });
    } finally {
      await release(pool);
    }
  });

  it.each([0, -1, 1.5, Number.NaN])('таймаут %p — отказ до обращения к базе', async (value) => {
    const seen: string[] = [];
    const pool = poolFailing({}, seen);
    try {
      await expect(
        transactionKeepingFailure(drizzle(pool), async () => 'не дошли', { lockTimeoutMs: value }),
      ).rejects.toThrow('lockTimeoutMs');
      expect(seen).toEqual([]);
    } finally {
      await release(pool);
    }
  });

  it.each([
    ['lockTimeoutMs', POSTGRES_LIMIT.MAX_TIMEOUT_MS + 1],
    ['statementTimeoutMs', POSTGRES_LIMIT.MAX_TIMEOUT_MS + 1],
    ['idleInTransactionTimeoutMs', Number.MAX_SAFE_INTEGER],
  ] as const)(
    '%s=%p выше int4 Postgres — отказ до соединения, а не 22023 после BEGIN',
    async (name, value) => {
      const seen: string[] = [];
      const pool = poolFailing({}, seen);
      try {
        await expect(
          transactionKeepingFailure(drizzle(pool), async () => 'не дошли', { [name]: value }),
        ).rejects.toThrow(`${name} — не больше ${POSTGRES_LIMIT.MAX_TIMEOUT_MS}`);
        expect(seen).toEqual([]);
      } finally {
        await release(pool);
      }
    },
  );

  it('таймаут ровно на пределе int4 — принимается сервером', async () => {
    const pool = poolFailing({});
    try {
      const inside = await transactionKeepingFailure(
        drizzle(pool),
        async (_tx, client) => setting(client, 'lock_timeout'),
        { lockTimeoutMs: POSTGRES_LIMIT.MAX_TIMEOUT_MS },
      );
      expect(inside).toBe(`${POSTGRES_LIMIT.MAX_TIMEOUT_MS}ms`);
    } finally {
      await release(pool);
    }
  });

  const failSerialization = (client: PoolClient): Promise<unknown> =>
    client.query(
      `DO $$ BEGIN RAISE EXCEPTION 'конфликт сериализации' USING ERRCODE = '${RETRYABLE_SQLSTATE.serializationFailure}'; END $$`,
    );

  it('повтор на 40001 — только если вызывающий его включил', async () => {
    const pool = poolFailing({});
    try {
      let attempts = 0;
      const work = async (_tx: unknown, client: PoolClient): Promise<string> => {
        attempts += 1;
        await client.query('INSERT INTO tkf VALUES ($1)', [`retry.${attempts}`]);
        if (attempts === 1) {
          await failSerialization(client);
        }
        return 'ok';
      };
      await expect(transactionKeepingFailure(drizzle(pool), work)).rejects.toMatchObject({ code: '40001' });
      expect(attempts).toBe(1);

      attempts = 0;
      await expect(
        transactionKeepingFailure(drizzle(pool), work, { retry: { attempts: 3, backoffMs: 5 } }),
      ).resolves.toBe('ok');
      expect(attempts).toBe(2);
      // Первая попытка откатана целиком, зафиксирована только вторая.
      expect(await names(pool, 'retry.%')).toEqual(['retry.2']);
      expect(checkedOut(pool)).toBe(0);
    } finally {
      await release(pool);
    }
  });

  it('повтор — не дольше заданного числа попыток и не на чужих ошибках', async () => {
    const pool = poolFailing({});
    try {
      let attempts = 0;
      await expect(
        transactionKeepingFailure(
          drizzle(pool),
          async (_tx, client) => {
            attempts += 1;
            await failSerialization(client);
          },
          { retry: { attempts: 3 } },
        ),
      ).rejects.toMatchObject({ code: '40001' });
      expect(attempts).toBe(3);

      attempts = 0;
      const unique = Object.assign(new Error('дубликат'), { code: '23505' });
      await expect(
        transactionKeepingFailure(
          drizzle(pool),
          async () => {
            attempts += 1;
            throw unique;
          },
          { retry: { attempts: 3 } },
        ),
      ).rejects.toBe(unique);
      expect(attempts).toBe(1);
    } finally {
      await release(pool);
    }
  });

  it('повтор видит 40001 и под wrapFailure — по цепочке cause', async () => {
    const pool = poolFailing({});
    try {
      let attempts = 0;
      await expect(
        transactionKeepingFailure(
          drizzle(pool),
          async (_tx, client) => {
            attempts += 1;
            if (attempts === 1) {
              await failSerialization(client);
            }
            return 'ok';
          },
          {
            retry: { attempts: 2 },
            wrapFailure: (_stage, error) => new Error('обёрнуто', { cause: error }),
          },
        ),
      ).resolves.toBe('ok');
      expect(attempts).toBe(2);
    } finally {
      await release(pool);
    }
  });

  it.each(['COMMIT', 'ROLLBACK'])(
    'ручной %s внутри работы — отказ, а не тихий успех; лишний ROLLBACK не уходит',
    async (command) => {
      const seen: string[] = [];
      const pool = poolFailing({}, seen);
      try {
        await expect(
          transactionKeepingFailure(drizzle(pool), async (_tx, client) => {
            await client.query('INSERT INTO tkf VALUES ($1)', [`manual.${command}`]);
            await client.query(command);
            await client.query('INSERT INTO tkf VALUES ($1)', [`manual.${command}.after`]);
          }),
        ).rejects.toBeInstanceOf(ManualTransactionControlError);
        expect(seen.filter((text) => text === 'rollback')).toEqual(
          command === 'ROLLBACK' ? ['rollback'] : [],
        );
        expect(checkedOut(pool)).toBe(0);
      } finally {
        await release(pool);
      }
    },
  );

  it('пул другой копии pg принимается по форме, клиент — нет', async () => {
    const pool = new Pool({ connectionString: database.url, max: 1 });
    try {
      // Пул из другой копии pg в монорепозитории: не `instanceof` нашего Pool.
      const foreign = {
        connect: () => pool.connect(),
        get totalCount() {
          return pool.totalCount;
        },
        get idleCount() {
          return pool.idleCount;
        },
      };
      expect(foreign instanceof Pool).toBe(false);
      await expect(
        transactionKeepingFailure({ $client: foreign } as never, async () => 'принят'),
      ).resolves.toBe('принят');
    } finally {
      await release(pool);
    }
  });

  /**
   * Транзакция строилась с `new PgDialect()` и схемой `undefined`: `tx.query`
   * был пуст (TypeError на `tx.query.authors`), у вложенной — тоже, `casing`
   * базы терялся (запрос шёл в колонку "fullName"), логгер базы молчал.
   * `db.transaction` drizzle берёт всё это из сессии базы — и пакет тоже.
   */
  it('транзакция наследует схему, casing и логгер базы: tx.query.* и вложенная работают', async () => {
    const pool = poolFailing({});
    const logged: string[] = [];
    const db = drizzle(pool, {
      schema: relationalSchema,
      casing: 'snake_case',
      logger: { logQuery: (query) => logged.push(query) },
    });
    try {
      const [withBooks, nestedRows, selected] = await transactionKeepingFailure(
        db,
        async (tx: RelationalTransaction) => [
          await tx.query.authors.findMany({ with: { books: true } }),
          await tx.transaction(async (nested) => nested.query.authors.findMany()),
          await tx.select({ name: authors.fullName }).from(authors),
        ],
      );
      expect(withBooks).toEqual([{ id: 1, fullName: 'автор', books: [{ id: 10, authorId: 1 }] }]);
      expect(nestedRows).toEqual([{ id: 1, fullName: 'автор' }]);
      expect(selected).toEqual([{ name: 'автор' }]);
      expect(logged.some((query) => query.includes('"full_name"'))).toBe(true);
      expect(checkedOut(pool)).toBe(0);
    } finally {
      await release(pool);
    }
  });

  /**
   * `client.release()` внутри работы отдавал соединение пулу посреди
   * транзакции: следующий `pool.connect()` получал его с открытой транзакцией,
   * а release в finally падал «already released» вместо результата работы.
   */
  it('client.release() внутри работы — отказ, соединение остаётся за транзакцией', async () => {
    const pool = poolFailing({});
    try {
      const outcome = await transactionKeepingFailure(drizzle(pool), async (_tx, client) => {
        await client.query('INSERT INTO tkf VALUES ($1)', ['release.inside']);
        const failure = (() => {
          try {
            client.release();
            return undefined;
          } catch (error) {
            return error;
          }
        })();
        // max=1: соединение, ушедшее в пул, стало бы свободным посреди работы.
        return { failure, idleDuringWork: pool.idleCount };
      });
      expect(outcome.failure).toBeInstanceOf(TransactionClientMisuseError);
      expect((outcome.failure as TransactionClientMisuseError).misuse).toBe(CLIENT_MISUSE.release);
      expect(outcome.idleDuringWork).toBe(0);
      expect(await names(pool, 'release.%')).toEqual(['release.inside']);
      expect(checkedOut(pool)).toBe(0);
      expect(pool.idleCount).toBe(1);
    } finally {
      await release(pool);
    }
  });

  it('запрос через соединение работы после конца транзакции — отказ, а не запись в чужую', async () => {
    const pool = poolFailing({});
    try {
      let kept: PoolClient | undefined;
      await transactionKeepingFailure(drizzle(pool), async (_tx, client) => {
        kept = client;
      });
      const failure = await Promise.resolve()
        .then(() => kept?.query('INSERT INTO tkf VALUES ($1)', ['after-end.x']))
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TransactionClientMisuseError);
      expect((failure as TransactionClientMisuseError).misuse).toBe(CLIENT_MISUSE.afterEnd);
      expect(await names(pool, 'after-end.%')).toEqual([]);
    } finally {
      await release(pool);
    }
  });

  it('шпион jest на соединении работы и сессии — работает и видит запросы tx.*; после конца — отказ', async () => {
    const pool = poolFailing({});
    try {
      const seen: string[] = [];
      let kept: PoolClient | undefined;
      await transactionKeepingFailure(drizzle(pool), async (tx, client) => {
        kept = client;
        const original = client.query.bind(client);
        const spy = jest.spyOn(client, 'query').mockImplementation(((config: unknown, values?: unknown) => {
          const text = typeof config === 'string' ? config : String((config as { text?: string }).text);
          seen.push(text);
          return original(config as string, values as unknown[]);
        }) as never);
        try {
          await tx.execute(sql`INSERT INTO tkf VALUES ('spy.tx')`);
          await client.query("INSERT INTO tkf VALUES ('spy.raw')");
        } finally {
          spy.mockRestore();
        }
      });
      expect(seen.some((text) => text.includes('spy.tx'))).toBe(true);
      expect(seen.some((text) => text.includes('spy.raw'))).toBe(true);
      expect(await names(pool, 'spy.%')).toEqual(['spy.raw', 'spy.tx']);
      const failure = await Promise.resolve()
        .then(() => kept?.query("INSERT INTO tkf VALUES ('spy.after')"))
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TransactionClientMisuseError);
    } finally {
      await release(pool);
    }
  });

  it('запрос через tx.* после конца транзакции — отказ, а не запись мимо неё', async () => {
    const pool = poolFailing({});
    try {
      let kept: { execute(query: ReturnType<typeof sql>): Promise<unknown> } | undefined;
      await transactionKeepingFailure(drizzle(pool), async (tx) => {
        kept = tx;
      });
      const failure = await Promise.resolve()
        .then(() => kept?.execute(sql`INSERT INTO tkf VALUES ('after-end.tx')`))
        .catch((error: unknown) => error);
      // drizzle оборачивает отказ драйвера в DrizzleQueryError, исходный — в cause.
      const misuse = (failure as { cause?: unknown }).cause;
      expect(misuse).toBeInstanceOf(TransactionClientMisuseError);
      expect((misuse as TransactionClientMisuseError).misuse).toBe(CLIENT_MISUSE.afterEnd);
      expect(await names(pool, 'after-end.%')).toEqual([]);
    } finally {
      await release(pool);
    }
  });

  it('запрос, отправленный работой без await, после её возврата — отказ, а не автокоммит после COMMIT', async () => {
    const pool = poolFailing({});
    try {
      let late: Promise<unknown> | undefined;
      await transactionKeepingFailure(drizzle(pool), async (tx) => {
        // Работа «забыла» await: запрос стартует следующей макрозадачей, когда
        // работа уже вернулась, а COMMIT ушёл в очередь соединения.
        late = new Promise((resolve) => setImmediate(resolve)).then(() =>
          tx.execute(sql`INSERT INTO tkf VALUES ('late.tx')`),
        );
      });
      const failure = await late?.catch((error: unknown) => error);
      const misuse = (failure as { cause?: unknown }).cause;
      expect(misuse).toBeInstanceOf(TransactionClientMisuseError);
      expect((misuse as TransactionClientMisuseError).misuse).toBe(CLIENT_MISUSE.afterEnd);
      expect(await names(pool, 'late.%')).toEqual([]);
    } finally {
      await release(pool);
    }
  });

  it('отменённый сигнал — отказ с причиной до соединения и BEGIN', async () => {
    const seen: string[] = [];
    const pool = poolFailing({}, seen);
    const controller = new AbortController();
    const reason = new Error('SIGTERM пода');
    controller.abort(reason);
    const work = jest.fn(async () => 'не дошли');
    try {
      await expect(
        transactionKeepingFailure(drizzle(pool), work, { signal: controller.signal }),
      ).rejects.toBe(reason);
      expect(work).not.toHaveBeenCalled();
      expect(seen).toEqual([]);
      expect(pool.totalCount).toBe(0);
    } finally {
      await release(pool);
    }
  });

  it('отмена в паузе между повторами — отказ сразу, новая попытка не начинается', async () => {
    const pool = poolFailing({});
    const controller = new AbortController();
    const reason = new Error('дедлайн запроса');
    let attempts = 0;
    try {
      const pending = transactionKeepingFailure(
        drizzle(pool),
        async (_tx, client) => {
          attempts += 1;
          if (attempts === 1) {
            setTimeout(() => controller.abort(reason), 20);
          }
          await failSerialization(client);
        },
        // Пауза — до 10 минут: без прерывания отказ пришёл бы по таймауту jest.
        { retry: { attempts: 5, backoffMs: 600_000 }, signal: controller.signal },
      );
      // Наружу — и причина отмены, и то, что повторялось (40001 в cause).
      const outcome = await withinSeconds(5, pending).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(TransactionRetryAbortedError);
      expect((outcome as TransactionRetryAbortedError).reason).toBe(reason);
      expect(((outcome as Error).cause as { code?: string } | undefined)?.code).toBe(
        RETRYABLE_SQLSTATE.serializationFailure,
      );
      expect(attempts).toBe(1);
      expect(checkedOut(pool)).toBe(0);
    } finally {
      await release(pool);
    }
  });

  it('отмена в ожидании соединения пула — отказ, пришедшее позже соединение вернулось в пул', async () => {
    const pool = poolFailing({});
    const held = await pool.connect();
    const controller = new AbortController();
    const reason = new Error('остановка');
    const work = jest.fn(async () => 'не дошли');
    try {
      setTimeout(() => controller.abort(reason), 100);
      await expect(
        withinSeconds(5, transactionKeepingFailure(drizzle(pool), work, { signal: controller.signal })),
      ).rejects.toBe(reason);
      expect(work).not.toHaveBeenCalled();
      held.release();
      // Соединение доходит до брошенного ожидания в следующем тике и уходит обратно.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(checkedOut(pool)).toBe(0);
      await expect(
        withinSeconds(
          5,
          transactionKeepingFailure(drizzle(pool), async () => 'пул жив'),
        ),
      ).resolves.toBe('пул жив');
    } finally {
      await release(pool);
    }
  });

  /**
   * Внешний аудит 14.11.2026 предлагал отказ до BEGIN на DEFERRABLE вне
   * SERIALIZABLE READ ONLY. Postgres такой BEGIN принимает (и не применяет),
   * а при `default_transaction_*` роли тот же BEGIN действует — отказ по опциям
   * отверг бы рабочую конфигурацию.
   */
  it('DEFERRABLE без SERIALIZABLE READ ONLY — BEGIN проходит, как у Postgres', async () => {
    const pool = poolFailing({});
    try {
      const inside = await transactionKeepingFailure(
        drizzle(pool),
        async (_tx, client) => [
          await setting(client, 'transaction_isolation'),
          await setting(client, 'transaction_deferrable'),
        ],
        { deferrable: true },
      );
      expect(inside).toEqual(['read committed', 'on']);
    } finally {
      await release(pool);
    }
  });

  /**
   * Пауза `backoffMs × 2^n` выше предела таймера Node (2^31 − 1 мс) не ждёт, а
   * срабатывает через 1 мс: повтор становился немедленным. Пауза зажата
   * пределом — значит отмена в ней застаёт ОДНУ попытку.
   */
  it('пауза повтора выше предела таймера — зажата, а не немедленный повтор', async () => {
    const pool = poolFailing({});
    const controller = new AbortController();
    const reason = new Error('отмена в длинной паузе');
    try {
      let attempts = 0;
      const timer = setTimeout(() => controller.abort(reason), 300);
      const outcome = await transactionKeepingFailure(
        drizzle(pool),
        async (_tx, client) => {
          attempts += 1;
          await failSerialization(client);
        },
        { retry: { attempts: 3, backoffMs: 1e15 }, signal: controller.signal },
      ).catch((error: unknown) => error);
      clearTimeout(timer);
      expect(outcome).toBeInstanceOf(TransactionRetryAbortedError);
      expect((outcome as TransactionRetryAbortedError).reason).toBe(reason);
      expect(attempts).toBe(1);
    } finally {
      await release(pool);
    }
  });

  it('retry.on lock-timeout: 55P03 повторяется, когда держатель отпустил строку; по умолчанию — нет', async () => {
    const pool = poolFailing({});
    const holder = new Client({ connectionString: database.url });
    await holder.connect();
    try {
      await pool.query("INSERT INTO tkf VALUES ('lock.row') ON CONFLICT DO NOTHING");
      await holder.query('BEGIN');
      await holder.query("SELECT 1 FROM tkf WHERE name = 'lock.row' FOR UPDATE");
      const touch = (tx: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> }) =>
        tx.execute(sql`UPDATE tkf SET name = name WHERE name = 'lock.row'`);
      // По умолчанию 55P03 не повторяется: отказ с первой попытки.
      let plain = 0;
      const once = await transactionKeepingFailure(
        drizzle(pool),
        async (tx) => {
          plain += 1;
          await touch(tx);
        },
        { lockTimeoutMs: 100, retry: { attempts: 3, backoffMs: 0 } },
      ).catch((error: unknown) => error);
      expect(((once as Error).cause as { code?: string } | undefined)?.code).toBe('55P03');
      expect(plain).toBe(1);
      // С причиной lock-timeout: держатель отпускает после первой попытки.
      const events: Array<[number, boolean]> = [];
      let attempts = 0;
      await transactionKeepingFailure(
        drizzle(pool),
        async (tx) => {
          attempts += 1;
          if (attempts === 2) {
            await holder.query('COMMIT');
          }
          await touch(tx);
        },
        {
          lockTimeoutMs: 100,
          retry: { attempts: 3, backoffMs: 0, on: [RETRY_REASON.lockTimeout] },
          observer: { attemptFailed: ({ attempt, willRetry }) => events.push([attempt, willRetry]) },
        },
      );
      expect(attempts).toBe(2);
      expect(events).toEqual([[1, true]]);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
      await release(pool);
    }
  });

  it('retry.on connection-before-work: обрыв на BEGIN повторяется, отказ сервера на BEGIN — нет', async () => {
    let beginFailures = 0;
    const dropped = new Error('Connection terminated unexpectedly');
    const pool = new Pool({ connectionString: database.url, max: 1 });
    pool.on('connect', (client: PoolClient) => {
      const original = client.query.bind(client) as (...args: unknown[]) => unknown;
      // biome-ignore lint/suspicious/noExplicitAny: подмена перегруженного метода драйвера
      (client as any).query = (...args: unknown[]): unknown => {
        if (args[0] === 'BEGIN' && beginFailures < 2) {
          beginFailures += 1;
          return Promise.reject(dropped);
        }
        return original(...args);
      };
    });
    try {
      let ran = 0;
      await transactionKeepingFailure(
        drizzle(pool),
        async () => {
          ran += 1;
        },
        { retry: { attempts: 3, backoffMs: 0, on: [RETRY_REASON.connectionBeforeWork] } },
      );
      expect([beginFailures, ran]).toEqual([2, 1]);
      // Сервер ответил ERROR — это не обрыв, повтора нет.
      const serverError = Object.assign(new Error('ошибка BEGIN'), { severity: 'ERROR', code: '22023' });
      const pool2 = poolFailing({ begin: serverError });
      try {
        let tries = 0;
        await expect(
          transactionKeepingFailure(
            drizzle(pool2),
            async () => {
              tries += 1;
            },
            {
              retry: { attempts: 3, backoffMs: 0, on: [RETRY_REASON.connectionBeforeWork] },
              observer: {
                attemptFailed: () => {
                  tries += 10;
                },
              },
            },
          ),
        ).rejects.toBe(serverError);
        expect(tries).toBe(10);
      } finally {
        await release(pool2);
      }
    } finally {
      await release(pool);
    }
  });

  it('retry.when — своя классификация поверх on; пустой on без when — отказ до соединения', async () => {
    const pool = poolFailing({});
    try {
      let attempts = 0;
      const custom = new Error('временный отказ внешнего ключа');
      const result = await transactionKeepingFailure(
        drizzle(pool),
        async () => {
          attempts += 1;
          if (attempts < 3) {
            throw custom;
          }
          return 'третья';
        },
        { retry: { attempts: 3, backoffMs: 0, on: [], when: (error) => error === custom } },
      );
      expect([result, attempts]).toEqual(['третья', 3]);
      const before = { total: pool.totalCount, idle: pool.idleCount };
      await expect(
        transactionKeepingFailure(drizzle(pool), async () => 'x', { retry: { attempts: 2, on: [] } }),
      ).rejects.toThrow('повторять нечего');
      await expect(
        transactionKeepingFailure(drizzle(pool), async () => 'x', {
          retry: { attempts: 2, on: ['typo' as never] },
        }),
      ).rejects.toThrow('неизвестные причины typo');
      expect({ total: pool.totalCount, idle: pool.idleCount }).toEqual(before);
    } finally {
      await release(pool);
    }
  });

  it('наблюдатель: ожидание соединения на каждую попытку; отказ наблюдателя транзакцию не роняет', async () => {
    const pool = poolFailing({});
    try {
      const waits: number[] = [];
      let attempts = 0;
      const result = await transactionKeepingFailure(
        drizzle(pool),
        async (_tx, client) => {
          attempts += 1;
          if (attempts === 1) {
            await failSerialization(client);
          }
          return 'ok';
        },
        {
          retry: { attempts: 2, backoffMs: 0 },
          observer: {
            connectionAcquired: ({ waitMs }) => {
              waits.push(waitMs);
              throw new Error('сломанный наблюдатель');
            },
          },
        },
      );
      expect(result).toBe('ok');
      expect(waits).toHaveLength(2);
      expect(waits.every((wait) => Number.isFinite(wait) && wait >= 0)).toBe(true);
    } finally {
      await release(pool);
    }
  });
});
