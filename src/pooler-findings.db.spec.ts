import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool, type PoolClient } from 'pg';

import { PoolerIncompatibleError } from './pooler-incompatible.error';
import { createTestDatabase } from './testing/test-database';
import { transactionKeepingFailure } from './transaction-keeping-failure';

const adminUrl = process.env.PG_TEST_URL;
const poolerUrl = process.env.PG_POOLER_URL;
const describePooler = adminUrl && poolerUrl ? describe : describe.skip;

jest.setTimeout(30_000);

/**
 * Две дыры защиты `transactionPooler`, подтверждённые на настоящем PgBouncer в
 * transaction mode (одно серверное соединение на базу): работа оставляла
 * сессионное состояние, и его видел следующий клиент пулера — «сосед».
 * Спека пользуется только API, которое было и до исправления: на прежнем коде
 * она красная.
 */
describePooler('transactionPooler: найденные дыры на PgBouncer [нужны PG_TEST_URL и PG_POOLER_URL]', () => {
  let database: { url: string; drop(): Promise<void> };
  let pool: Pool;
  let url: string;

  beforeEach(async () => {
    database = await createTestDatabase(adminUrl as string);
    const target = new URL(poolerUrl as string);
    target.pathname = new URL(database.url).pathname;
    url = target.toString();
    pool = new Pool({ connectionString: url, max: 2 });
  });
  afterEach(async () => {
    await pool?.end();
    await database?.drop();
  });

  const neighbor = async <R>(text: string): Promise<R & { pid: number }> => {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      return (await client.query(`SELECT pg_backend_pid() AS pid, * FROM (${text}) AS probe`)).rows[0];
    } finally {
      await client.end();
    }
  };

  const attempt = (work: (client: PoolClient) => Promise<unknown>, transactionPooler: boolean) =>
    transactionKeepingFailure(drizzle(pool), async (_tx, client) => work(client), { transactionPooler }).then(
      () => 'прошло',
      (error: unknown) => (error instanceof PoolerIncompatibleError ? 'отказ пулера' : error),
    );

  const pid = () =>
    transactionKeepingFailure(
      drizzle(pool),
      async (_tx, client) =>
        (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid,
    );

  it('стенд: без защиты обе формы доезжают до соседа на ТОМ ЖЕ серверном соединении', async () => {
    const ours = await pid();
    expect(await attempt((client) => client.query('CREATE TEMP TABLE control_t (x int)'), false)).toBe(
      'прошло',
    );
    expect(
      await attempt(
        (client) => client.query('SELECT set_config($1, $2, $3)', ['app.leak', 'control', false]),
        false,
      ),
    ).toBe('прошло');
    expect(
      await neighbor(
        "SELECT to_regclass('pg_temp.control_t')::text AS t, current_setting('app.leak', true) AS s",
      ),
    ).toEqual({ pid: ours, t: 'control_t', s: 'control' });
  });

  it('находка 1: CREATE TEMP TABLE без ON COMMIT DROP — отказ до отправки, сосед таблицы не видит', async () => {
    expect(await attempt((client) => client.query('CREATE TEMP TABLE leak_t (x int)'), true)).toBe(
      'отказ пулера',
    );
    expect(await neighbor("SELECT to_regclass('pg_temp.leak_t')::text AS t")).toEqual({
      pid: expect.any(Number),
      t: null,
    });
  });

  it('находка 2: set_config($1, $2, $3) с is_local = false ПАРАМЕТРОМ — отказ до отправки, сосед параметра не видит', async () => {
    expect(
      await attempt(
        (client) => client.query('SELECT set_config($1, $2, $3)', ['app.leak', 'from-param', false]),
        true,
      ),
    ).toBe('отказ пулера');
    const seen = await neighbor<{ s: string | null }>("SELECT current_setting('app.leak', true) AS s");
    expect(seen.s ?? '').toBe('');
  });

  it('законные двойники проходят: ON COMMIT DROP и set_config($1, $2, $3) со значением true', async () => {
    expect(
      await attempt(async (client) => {
        await client.query('CREATE TEMP TABLE scratch (x int) ON COMMIT DROP');
        await client.query('SELECT set_config($1, $2, $3)', ['app.local', 'v', true]);
      }, true),
    ).toBe('прошло');
    expect(
      await neighbor(
        "SELECT to_regclass('pg_temp.scratch')::text AS t, current_setting('app.local', true) AS s",
      ),
    ).toEqual({ pid: expect.any(Number), t: null, s: '' });
  });
});
