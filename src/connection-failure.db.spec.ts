import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool, type PoolClient } from 'pg';

import { CommitOutcomeUnknownError } from './commit-outcome-unknown.error';
import { RETRY_REASON } from './constants/retry-reason.constant';
import { startFreezingProxy } from './testing/freezing-proxy';
import { createTestDatabase } from './testing/test-database';
import { withinSeconds } from './testing/within-seconds';
import { TransactionClientMisuseError } from './transaction-client-misuse.error';
import { TransactionConnectionLostError } from './transaction-connection-lost.error';
import { transactionKeepingFailure } from './transaction-keeping-failure';

const adminUrl = process.env.PG_TEST_URL;
const describeDb = adminUrl ? describe : describe.skip;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Разрыв сессии сервером, пока соединение выдано транзакции: pg-pool снимает
 * свой обработчик 'error' при выдаче, и ошибка без активного запроса — это
 * `emit('error')` без слушателя, то есть падение процесса. Здесь разрыв
 * настоящий: истёкший idle_in_transaction_session_timeout и pg_terminate_backend.
 */
describeDb('разрыв соединения транзакции [нужен PG_TEST_URL]', () => {
  let database: { url: string; drop(): Promise<void> };

  beforeAll(async () => {
    database = await createTestDatabase(adminUrl as string, [
      'CREATE TABLE cf (name text PRIMARY KEY)',
      'CREATE TABLE cf_deferred (id integer UNIQUE DEFERRABLE INITIALLY DEFERRED)',
    ]);
  });
  afterAll(async () => {
    await database?.drop();
  });

  const names = async (pool: Pool, like: string): Promise<string[]> =>
    (await pool.query<{ name: string }>('SELECT name FROM cf WHERE name LIKE $1', [like])).rows.map(
      (row) => row.name,
    );

  it.each([
    ['базы нет (3D000)', 'database', '3D000'],
    ['роль без права входа (класс 28)', 'role', '28000'],
  ])(
    'connection-before-work: отказ подключения, который повтор не исправит (%s), — одна попытка',
    async (_name, kind, code) => {
      const url = new URL(database.url);
      const role = `cf_nologin_${process.pid}`;
      const admin = new Client({ connectionString: database.url });
      await admin.connect();
      try {
        if (kind === 'database') {
          url.pathname = '/cf_no_such_database';
        } else {
          await admin.query(`CREATE ROLE ${role} NOLOGIN`);
          url.username = role;
        }
        const pool = new Pool({ connectionString: url.toString(), max: 1 });
        const attempts: Array<[number, boolean, unknown]> = [];
        try {
          const failure = await withinSeconds(
            10,
            transactionKeepingFailure(drizzle(pool), async () => 'x', {
              retry: { attempts: 3, backoffMs: 0, on: [RETRY_REASON.connectionBeforeWork] },
              observer: {
                attemptFailed: ({ attempt, willRetry, error }) =>
                  attempts.push([attempt, willRetry, (error as { code?: unknown }).code]),
              },
            }),
          ).catch((error: unknown) => error);
          // Роль без пароля: под trust сервер отвечает 28000, под паролем — 28P01 (тот же класс 28).
          const got = (failure as { code?: unknown }).code;
          expect(String(got).slice(0, code.length - 3)).toBe(code.slice(0, code.length - 3));
          expect(attempts).toEqual([[1, false, got]]);
        } finally {
          await pool.end();
        }
      } finally {
        if (kind === 'role') {
          await admin.query(`DROP ROLE IF EXISTS ${role}`);
        }
        await admin.end();
      }
    },
  );

  it.each([
    ["removeAllListeners('error')", (client: PoolClient) => client.removeAllListeners('error')],
    ['removeAllListeners()', (client: PoolClient) => client.removeAllListeners()],
    [
      "off('error') каждого слушателя",
      (client: PoolClient) => {
        for (const listener of client.listeners('error')) {
          client.off('error', listener as (error: Error) => void);
        }
      },
    ],
    [
      "removeListener('error') каждого слушателя",
      (client: PoolClient) => {
        for (const listener of client.listeners('error')) {
          client.removeListener('error', listener as (error: Error) => void);
        }
      },
    ],
  ])(
    'работа снимает слушатели соединения (%s) — обработчик пакета остаётся: разрыв сервером даёт отказ, а не падение процесса',
    async (_name, strip) => {
      const pool = new Pool({ connectionString: database.url, max: 1 });
      pool.on('error', () => undefined);
      const admin = new Client({ connectionString: database.url });
      await admin.connect();
      try {
        const counts: number[] = [];
        const failure = await withinSeconds(
          10,
          transactionKeepingFailure(drizzle(pool), async (_tx, client) => {
            const own = (): void => undefined;
            client.on('error', own);
            counts.push(client.listenerCount('error'));
            strip(client);
            // Снят только свой слушатель работы; обработчик пакета на месте.
            counts.push(client.listenerCount('error'));
            if (counts[1] !== 1) {
              // Обработчик пакета снят: разрыв сейчас уронил бы процесс jest — отказ проверкой ниже.
              return 'снят';
            }
            const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
            await admin.query('SELECT pg_terminate_backend($1)', [pid]);
            await pause(500);
            return 'ok';
          }),
        ).catch((error: unknown) => error);
        expect(counts).toEqual([2, 1]);
        expect(failure).toBeInstanceOf(TransactionConnectionLostError);
        expect(pool.totalCount).toBe(0);
      } finally {
        await admin.end();
        await pool.end();
      }
    },
  );

  it('ссылка на client.query, взятая в работе заранее, после конца транзакции — отказ, а не запрос мимо неё', async () => {
    const pool = new Pool({ connectionString: database.url, max: 1 });
    try {
      let late: Promise<unknown> | undefined;
      await withinSeconds(
        5,
        transactionKeepingFailure(drizzle(pool), async (_tx, client) => {
          const query = client.query as (text: string) => Promise<unknown>;
          late = new Promise((resolve) => setTimeout(resolve, 100)).then(() =>
            query.call(client, "INSERT INTO cf VALUES ('late.ref')"),
          );
        }),
      );
      await expect(late).rejects.toBeInstanceOf(TransactionClientMisuseError);
      expect(await names(pool, 'late.%')).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it('сервер прервал простаивающую транзакцию (idle_in_transaction timeout): отказ, процесс жив, соединение уничтожено', async () => {
    const pool = new Pool({ connectionString: database.url, max: 1 });
    const poolErrors: unknown[] = [];
    pool.on('error', (error) => poolErrors.push(error));
    const destroyed: Array<{ stage: string; code: unknown }> = [];
    try {
      const outcome = transactionKeepingFailure(
        drizzle(pool),
        async (tx) => {
          await tx.execute(sql`INSERT INTO cf VALUES ('idle.first')`);
          // Простой дольше потолка: сервер шлёт FATAL 25P03 без активного запроса.
          await pause(1_500);
          await tx.execute(sql`INSERT INTO cf VALUES ('idle.second')`);
        },
        {
          idleInTransactionTimeoutMs: 300,
          observer: {
            connectionDestroyed: ({ stage, error }) =>
              destroyed.push({ stage, code: (error as { code?: unknown }).code }),
          },
        },
      );
      const failure = await withinSeconds(10, outcome).catch((error: unknown) => error);
      // Наружу — разрыв с причиной сервера, а не «not queryable» следующего запроса.
      expect(failure).toBeInstanceOf(TransactionConnectionLostError);
      expect(((failure as Error).cause as { code?: string }).code).toBe('25P03');
      expect(pool.totalCount).toBe(0);
      expect(await names(pool, 'idle.%')).toEqual([]);
      expect(poolErrors).toEqual([]);
      // Наблюдатель видит уничтожение с причиной сервера — метрика «сломанные соединения».
      expect(destroyed).toEqual([{ stage: 'work', code: '25P03' }]);
    } finally {
      await pool.end();
    }
  });

  it('pg_terminate_backend посреди работы: отказ, процесс жив, следующий вызов получает исправное соединение', async () => {
    const pool = new Pool({ connectionString: database.url, max: 1 });
    const poolErrors: unknown[] = [];
    pool.on('error', (error) => poolErrors.push(error));
    const admin = new Client({ connectionString: database.url });
    await admin.connect();
    try {
      const outcome = transactionKeepingFailure(drizzle(pool), async (tx, client) => {
        await tx.execute(sql`INSERT INTO cf VALUES ('term.first')`);
        const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        await admin.query('SELECT pg_terminate_backend($1)', [rows[0]?.pid]);
        // Разрыв доходит до клиента, пока работа ждёт чужого.
        await pause(500);
        await tx.execute(sql`INSERT INTO cf VALUES ('term.second')`);
      });
      const failure = await withinSeconds(10, outcome).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TransactionConnectionLostError);
      expect(((failure as Error).cause as { code?: string }).code).toBe('57P01');
      expect(pool.totalCount).toBe(0);
      await transactionKeepingFailure(drizzle(pool), async (tx) => {
        await tx.execute(sql`INSERT INTO cf VALUES ('term.after')`);
      });
      expect(await names(pool, 'term.%')).toEqual(['term.after']);
      expect(poolErrors).toEqual([]);
    } finally {
      await admin.end();
      await pool.end();
    }
  });

  it('ROLLBACK на замёрзшем соединении — по потолку: отказ работы наружу, слот пула свободен', async () => {
    const target = new URL(database.url);
    const proxy = await startFreezingProxy({ host: target.hostname, port: Number(target.port) });
    const viaProxy = new URL(database.url);
    viaProxy.port = String(proxy.port);
    const pool = new Pool({ connectionString: viaProxy.toString(), max: 1 });
    const workFailure = new Error('отказ работы при замёрзшей сети');
    try {
      const outcome = transactionKeepingFailure(
        drizzle(pool),
        async (tx) => {
          await tx.execute(sql`INSERT INTO cf VALUES ('frozen.x')`);
          proxy.freeze();
          throw workFailure;
        },
        { rollbackTimeoutMs: 300 },
      );
      // Без потолка ROLLBACK ждал бы ответа до таймаута TCP ОС — минуты.
      await expect(withinSeconds(5, outcome)).rejects.toBe(workFailure);
      expect(pool.totalCount).toBe(0);
      proxy.thaw();
      // Следующая транзакция получает новое соединение и видит, что откат был.
      await withinSeconds(
        5,
        transactionKeepingFailure(drizzle(pool), async (tx) => {
          await tx.execute(sql`INSERT INTO cf VALUES ('frozen.after')`);
        }),
      );
      expect(await names(pool, 'frozen.%')).toEqual(['frozen.after']);
    } finally {
      await withinSeconds(5, pool.end()).catch(() => undefined);
      await proxy.close();
    }
  });

  it('обрыв сразу после отправки COMMIT: исход неизвестен (а запись на деле есть), соединение уничтожено', async () => {
    const pool = new Pool({ connectionString: database.url, max: 1 });
    pool.on('connect', (client) => {
      const original = client.query.bind(client) as (...args: unknown[]) => unknown;
      // biome-ignore lint/suspicious/noExplicitAny: подмена перегруженного метода драйвера
      (client as any).query = (...args: unknown[]): unknown => {
        const pending = original(...args);
        if (args[0] === 'COMMIT') {
          // COMMIT уже в сокете — сервер его выполнит, а ответ не дойдёт.
          (client as unknown as { connection: { stream: { destroy(): void } } }).connection.stream.destroy();
        }
        return pending;
      };
    });
    try {
      const outcome = await transactionKeepingFailure(drizzle(pool), async (tx) => {
        await tx.execute(sql`INSERT INTO cf VALUES ('unknown.x')`);
      }).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(CommitOutcomeUnknownError);
      expect(pool.totalCount).toBe(0);
      // Ровно поэтому «упало» было бы враньём: транзакция зафиксирована.
      expect(await names(pool, 'unknown.%')).toEqual(['unknown.x']);
    } finally {
      await pool.end();
    }
  });

  it('сервер отверг COMMIT (отложенное ограничение): исход известен — наружу сам отказ, соединение исправно', async () => {
    const pool = new Pool({ connectionString: database.url, max: 1 });
    try {
      const outcome = await transactionKeepingFailure(drizzle(pool), async (_tx, client) => {
        await client.query('INSERT INTO cf_deferred VALUES (1), (1)');
      }).catch((error: unknown) => error);
      expect(outcome).not.toBeInstanceOf(CommitOutcomeUnknownError);
      expect((outcome as { code?: unknown }).code).toBe('23505');
      expect(pool.totalCount).toBe(1);
      expect(pool.idleCount).toBe(1);
      expect((await pool.query('SELECT count(*)::int AS n FROM cf_deferred')).rows[0]?.n).toBe(0);
    } finally {
      await pool.end();
    }
  });
});
