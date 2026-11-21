import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';

import { PoolerIncompatibleError } from './pooler-incompatible.error';
import { createTestDatabase } from './testing/test-database';
import { transactionKeepingFailure } from './transaction-keeping-failure';

const adminUrl = process.env.PG_TEST_URL;
const describeDb = adminUrl ? describe : describe.skip;

/**
 * Сессионное состояние работы на соединении пула. Пул max=1: следующая
 * транзакция получает то же соединение и видит, что осталось от предыдущей.
 */
describeDb('сессионное состояние: resetSession и transactionPooler [нужен PG_TEST_URL]', () => {
  let database: { url: string; drop(): Promise<void> };

  beforeAll(async () => {
    database = await createTestDatabase(adminUrl as string);
  });
  afterAll(async () => {
    await database?.drop();
  });

  /** Работа, оставляющая сессионное состояние всех видов. */
  const dirty = async (_tx: unknown, client: PoolClient): Promise<void> => {
    await client.query("SET application_name = 'leaked'");
    await client.query('SELECT pg_advisory_lock(4242)');
    await client.query('CREATE TEMP TABLE leaked_tmp (x int)');
    await client.query('LISTEN leaked_channel');
  };

  const sessionState = (pool: Pool) =>
    transactionKeepingFailure(drizzle(pool), async (_tx, client) => {
      const { rows } = await client.query<{
        app: string;
        locks: number;
        temp: string | null;
        channels: string[];
      }>(
        `SELECT current_setting('application_name') AS app,
                (SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()) AS locks,
                to_regclass('pg_temp.leaked_tmp')::text AS temp,
                ARRAY(SELECT pg_listening_channels()) AS channels`,
      );
      return rows[0];
    });

  it('без resetSession состояние работы уезжает следующему владельцу соединения', async () => {
    const pool = new Pool({ connectionString: database.url, max: 1 });
    try {
      await transactionKeepingFailure(drizzle(pool), dirty);
      expect(await sessionState(pool)).toEqual({
        app: 'leaked',
        locks: 1,
        temp: 'leaked_tmp',
        channels: ['leaked_channel'],
      });
    } finally {
      await pool.end();
    }
  });

  it('resetSession: следующий владелец получает чистую сессию — и после успеха, и после отказа', async () => {
    const pool = new Pool({ connectionString: database.url, max: 1, application_name: 'pool-app' });
    const clean = { app: 'pool-app', locks: 0, temp: null, channels: [] };
    try {
      await transactionKeepingFailure(drizzle(pool), dirty, { resetSession: true });
      expect(await sessionState(pool)).toEqual(clean);
      await transactionKeepingFailure(
        drizzle(pool),
        async (tx, client) => {
          await dirty(tx, client);
          throw new Error('отказ работы');
        },
        { resetSession: true },
      ).catch(() => undefined);
      expect(await sessionState(pool)).toEqual(clean);
      // То же соединение — уборка, а не уничтожение.
      expect(pool.totalCount).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it('resetSession не снимает подготовленные операторы драйвера: именованный запрос работает и после уборки', async () => {
    const pool = new Pool({ connectionString: database.url, max: 1 });
    const named = { name: 'stmt_after_reset', text: 'SELECT $1::int + 1 AS n', values: [1] };
    try {
      for (let round = 0; round < 3; round += 1) {
        const n = await transactionKeepingFailure(
          drizzle(pool),
          async (_tx, client) => (await client.query<{ n: number }>(named)).rows[0]?.n,
          { resetSession: true },
        );
        expect(n).toBe(2);
      }
      expect(pool.totalCount).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it('transactionPooler: сессионные запросы и именованные операторы — отказ до отправки в базу', async () => {
    const pool = new Pool({ connectionString: database.url, max: 1 });
    const sent: string[] = [];
    pool.on('connect', (client: PoolClient) => {
      const original = client.query.bind(client) as (...args: unknown[]) => unknown;
      // biome-ignore lint/suspicious/noExplicitAny: подмена перегруженного метода драйвера
      (client as any).query = (...args: unknown[]): unknown => {
        const first = args[0] as string | { text?: string };
        sent.push(typeof first === 'string' ? first : (first.text ?? ''));
        return original(...args);
      };
    });
    const refused = [
      "SET application_name = 'x'",
      '/* hint */ SET search_path = public',
      'RESET ALL',
      'LISTEN channel',
      'SELECT pg_advisory_lock(1)',
      "SELECT set_config('app.x', '1', false)",
      'DECLARE c CURSOR WITH HOLD FOR SELECT 1',
      'SELECT 1; SET work_mem = 1',
    ];
    try {
      for (const text of refused) {
        const outcome = await transactionKeepingFailure(
          drizzle(pool),
          async (_tx, client) => client.query(text),
          { transactionPooler: true },
        ).catch((error: unknown) => error);
        expect([text, outcome instanceof PoolerIncompatibleError]).toEqual([text, true]);
      }
      const named = await transactionKeepingFailure(
        drizzle(pool),
        async (_tx, client) => client.query({ name: 'n1', text: 'SELECT 1' }),
        { transactionPooler: true },
      ).catch((error: unknown) => error);
      expect(named).toBeInstanceOf(PoolerIncompatibleError);
      // Ни один отвергнутый запрос до базы не дошёл: только BEGIN и ROLLBACK
      // (под пулером — тем же сообщением, что сверка состояния соединения).
      expect(sent.filter((text) => !['BEGIN', 'ROLLBACK'].includes(text.split(';')[0] as string))).toEqual(
        [],
      );
      // Совместимое — проходит: SET LOCAL, xact-лок, set_config(…, true).
      const allowed = await transactionKeepingFailure(
        drizzle(pool),
        async (_tx, client) => {
          await client.query("SET LOCAL application_name = 'tx'");
          await client.query('SELECT pg_advisory_xact_lock(1)');
          await client.query("SELECT set_config('app.x', '1', true)");
          return 'ok';
        },
        { transactionPooler: true },
      );
      expect(allowed).toBe('ok');
      expect(pool.totalCount).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it('transactionPooler вместе с resetSession — отказ до соединения', async () => {
    const pool = new Pool({ connectionString: database.url, max: 1 });
    try {
      await expect(
        transactionKeepingFailure(drizzle(pool), async () => 'x', {
          transactionPooler: true,
          resetSession: true,
        }),
      ).rejects.toThrow('resetSession под пулером');
      expect(pool.totalCount).toBe(0);
    } finally {
      await pool.end();
    }
  });
});
