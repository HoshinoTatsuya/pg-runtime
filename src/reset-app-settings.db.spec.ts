import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool, type PoolClient } from 'pg';

import { CommitRolledBackError } from './commit-rolled-back.error';
import { SESSION_STATE_KIND } from './constants/session-state-kind.constant';
import { PoolerIncompatibleError } from './pooler-incompatible.error';
import { SessionStateLeakError } from './session-state-leak.error';
import { createTestDatabase } from './testing/test-database';
import { transactionKeepingFailure } from './transaction-keeping-failure';

const adminUrl = process.env.PG_TEST_URL;
const poolerUrl = process.env.PG_POOLER_URL;
const describeDb = adminUrl ? describe : describe.skip;
const describePooler = adminUrl && poolerUrl ? describe : describe.skip;

jest.setTimeout(30_000);

/** Значение параметра библиотеки по умолчанию базы — то, что видит свежая сессия. */
const DB_DEFAULT = 'db-default';

/** Схема базы набора: параметр библиотеки с умолчанием на базе. */
const SETUP = [
  'CREATE TABLE rows (v int NOT NULL)',
  `DO $$BEGIN EXECUTE format('ALTER DATABASE %I SET lib.marker = %L', current_database(), '${DB_DEFAULT}'); END$$`,
];

/** Работа пользователя оставляет параметр библиотеки в сессии в обход текстового фильтра. */
const LEAK_IN_DO = "DO $$BEGIN EXECUTE 'SELECT set_config(''lib.marker'', ''leaked'', ' || 'false)'; END$$";

/**
 * Опции библиотеки-обёртки: свой параметр на транзакцию и его сброс в конце
 * работы. Переменная, а не литерал в вызове: набор компилируется и на коде без
 * опции — там она просто не действует (так снят «красный до правки»).
 */
const libraryOptions = (transactionPooler: boolean) => ({
  transactionPooler,
  localSettings: { 'lib.marker': 'library' },
  resetAppSettings: ['lib.marker'],
});

/** Библиотека-обёртка над `transactionKeepingFailure`: работа пользователя внутри её транзакции. */
const withLibrary = <T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
  transactionPooler: boolean,
  extra: Record<string, unknown> = {},
): Promise<{ value: T } | { error: unknown }> => {
  const options = { ...libraryOptions(transactionPooler), ...extra };
  return transactionKeepingFailure(drizzle(pool), (_tx, client) => work(client), options).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
};

/**
 * `resetAppSettings` на настоящем PgBouncer в transaction mode: ОДНО серверное
 * соединение на базу, «сосед» — второй клиент пулера на том же серверном
 * соединении. Сценарий потребителя: библиотека-обёртка задаёт свой параметр на
 * транзакцию и в конце работы обязана сбросить его сессионное значение —
 * работа пользователя могла оставить его в обход текста (`EXECUTE` в DO), а
 * свои параметры сверка состояния не видит. До 0.7.1 сброс отвергал сам фильтр
 * пулера (`set_config(…, false)` в любой форме), и библиотеке оставалось ходить
 * мимо обёртки соединения.
 */
describePooler('resetAppSettings под PgBouncer [нужны PG_TEST_URL и PG_POOLER_URL]', () => {
  let database: { url: string; drop(): Promise<void> };
  let pool: Pool;
  let url: string;

  beforeEach(async () => {
    database = await createTestDatabase(adminUrl as string, SETUP);
    const target = new URL(poolerUrl as string);
    target.pathname = new URL(database.url).pathname;
    url = target.toString();
    pool = new Pool({ connectionString: url, max: 1 });
  });
  afterEach(async () => {
    await pool?.end();
    await database?.drop();
  });

  /** Запрос отдельным клиентом: `through` — пулер (сосед) или сервер напрямую (свежая сессия). */
  const look = async (
    through: string,
    text: string,
  ): Promise<{ row: Record<string, unknown>; pid: number }> => {
    const client = new Client({ connectionString: through });
    await client.connect();
    try {
      const { rows } = await client.query(`SELECT pg_backend_pid() AS pid, * FROM (${text}) AS probe`);
      const { pid, ...row } = rows[0] as { pid: number } & Record<string, unknown>;
      return { row, pid };
    } finally {
      await client.end();
    }
  };

  const MARKER = "SELECT current_setting('lib.marker', true) AS marker";

  it('сценарий потребителя: значение, оставленное работой в обход текста, до соседа не доходит — у соседа то же, что у свежей сессии', async () => {
    let ourPid = 0;
    const outcome = await withLibrary(
      pool,
      async (client) => {
        ourPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? 0;
        await client.query('INSERT INTO public.rows VALUES (1)');
        await client.query(LEAK_IN_DO);
        return 'готово';
      },
      true,
    );
    expect(outcome).toEqual({ value: 'готово' });
    const seen = await look(url, `${MARKER}, (SELECT count(*)::int FROM public.rows) AS written`);
    const fresh = await look(database.url, MARKER);
    // Сосед — на том же серверном соединении: иначе проверка ничего не доказывает.
    expect(seen.pid).toBe(ourPid);
    expect(seen.row).toEqual({ marker: DB_DEFAULT, written: 1 });
    expect(fresh.row).toEqual({ marker: DB_DEFAULT });
  });

  it('сброс не объявляет параметр, которого в сессии не было: у соседа NULL, как у свежей сессии', async () => {
    const outcome = await withLibrary(pool, async () => 'готово', true, {
      localSettings: {},
      resetAppSettings: ['lib.never_set'],
    });
    expect(outcome).toEqual({ value: 'готово' });
    const seen = await look(url, "SELECT current_setting('lib.never_set', true) AS never");
    const fresh = await look(database.url, "SELECT current_setting('lib.never_set', true) AS never");
    expect([seen.row, fresh.row]).toEqual([{ never: null }, { never: null }]);
  });

  // Двойник: та же форма сброса из работы пользователя — по-прежнему отказ фильтра,
  // и опция библиотеки его не открывает.
  it.each([
    ['RESET lib.marker', []],
    ["SELECT set_config('lib.marker', NULL, false)", []],
    ["SELECT set_config('lib.marker', '', false)", []],
    ['SELECT set_config($1, NULL, $2)', ['lib.marker', false]],
  ])(
    'работа пользователя с тем же сбросом (%s) — PoolerIncompatibleError, до сервера не дошло',
    async (text, values) => {
      let sent = false;
      const outcome = await withLibrary(
        pool,
        async (client) => {
          await client.query(text, values);
          sent = true;
        },
        true,
      );
      expect(outcome).toEqual({ error: expect.any(PoolerIncompatibleError) });
      expect(sent).toBe(false);
    },
  );

  it('сброс не маскирует сверку: параметр Postgres, оставленный в обход текста, — по-прежнему SessionStateLeakError', async () => {
    const outcome = await withLibrary(
      pool,
      async (client) => {
        await client.query(LEAK_IN_DO);
        await client.query(
          "DO $$BEGIN EXECUTE 'SELECT set_config(''work_mem'', ''7MB'', ' || 'false)'; END$$",
        );
      },
      true,
    );
    expect(outcome).toEqual({ error: expect.any(SessionStateLeakError) });
    const error = (outcome as { error: SessionStateLeakError }).error;
    expect([error.committed, error.changes]).toEqual([
      true,
      [
        expect.objectContaining({
          kind: SESSION_STATE_KIND.setting,
          change: 'appeared',
          item: 'work_mem = 7168',
        }),
      ],
    ]);
    // Свой параметр сброшен и здесь: сброс идёт до COMMIT, а сверка — после.
    expect((await look(url, MARKER)).row).toEqual({ marker: DB_DEFAULT });
  });

  it('работа поймала отказ запроса и вернула успех: сброс в прерванной транзакции не подменяет CommitRolledBackError', async () => {
    const outcome = await withLibrary(
      pool,
      async (client) => {
        await client.query('INSERT INTO public.rows VALUES (1)');
        await client.query('SELECT 1 / 0').catch(() => undefined);
        return 'вернула успех';
      },
      true,
    );
    expect(outcome).toEqual({ error: expect.any(CommitRolledBackError) });
    expect((await look(url, 'SELECT count(*)::int AS written FROM public.rows')).row).toEqual({ written: 0 });
  });
});

/**
 * Без пулера: тот же сброс на соединении пула (max=1 — следующая транзакция
 * получает то же соединение), отдельно и вместе с уборкой `resetSession`.
 */
describeDb('resetAppSettings без пулера [нужен PG_TEST_URL]', () => {
  let database: { url: string; drop(): Promise<void> };
  let pool: Pool;

  beforeEach(async () => {
    database = await createTestDatabase(adminUrl as string, SETUP);
  });
  afterEach(async () => {
    await pool?.end();
    await database?.drop();
  });

  const next = async (): Promise<Record<string, unknown> | undefined> =>
    transactionKeepingFailure(drizzle(pool), async (_tx, client) => {
      const { rows } = await client.query(
        "SELECT current_setting('lib.marker', true) AS marker, current_setting('search_path') AS path",
      );
      return rows[0] as Record<string, unknown>;
    });

  it('работа задала параметр библиотеки сессионно — следующий владелец соединения видит значение по умолчанию базы', async () => {
    pool = new Pool({ connectionString: database.url, max: 1 });
    const outcome = await withLibrary(
      pool,
      async (client) => {
        await client.query("SELECT set_config('lib.marker', 'leaked', false)");
        return 'готово';
      },
      false,
    );
    expect(outcome).toEqual({ value: 'готово' });
    expect(await next()).toEqual({ marker: DB_DEFAULT, path: '"$user", public' });
  });

  it('вместе с resetSession (базовая линия connect): параметры connect остаются, параметр библиотеки сброшен', async () => {
    pool = new Pool({ connectionString: database.url, max: 1 });
    pool.on('connect', (client) => {
      client.query('SET search_path = pg_catalog, public').catch(() => undefined);
    });
    const outcome = await withLibrary(
      pool,
      async (client) => {
        await client.query("SELECT set_config('lib.marker', 'leaked', false)");
        await client.query("SET search_path = 'leaked'");
        return 'готово';
      },
      false,
      { resetSession: true },
    );
    expect(outcome).toEqual({ value: 'готово' });
    expect(await next()).toEqual({ marker: DB_DEFAULT, path: 'pg_catalog, public' });
    expect(pool.totalCount).toBe(1);
  });

  it.each([
    [['work_mem'], 'параметр Postgres без префикса'],
    [['lib.'], 'неполное имя'],
    [['lib.marker; DROP TABLE rows'], 'не имя'],
    [[''], 'пустое имя'],
    [[1], 'не строка'],
    ['lib.marker', 'не массив'],
  ] as const satisfies ReadonlyArray<readonly [unknown, string]>)(
    'resetAppSettings %j (%s) — отказ до соединения',
    async (names, _why) => {
      pool = new Pool({ connectionString: database.url, max: 1 });
      const outcome = await withLibrary(pool, async () => 'не дошло', false, { resetAppSettings: names });
      expect(outcome).toEqual({
        error: expect.objectContaining({ message: expect.stringContaining('resetAppSettings') }),
      });
      expect(pool.totalCount).toBe(0);
    },
  );

  it('под точкой сохранения — отказ: сброс посреди внешней транзакции снял бы её параметры', async () => {
    pool = new Pool({ connectionString: database.url, max: 1 });
    const outcome = await transactionKeepingFailure(drizzle(pool), async () => {
      const inner = { nested: 'savepoint' as const, resetAppSettings: ['lib.marker'] };
      return transactionKeepingFailure(drizzle(pool), async () => 'не дошло', inner).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    });
    expect(outcome).toEqual({
      error: expect.objectContaining({ message: expect.stringContaining('resetAppSettings') }),
    });
  });
});
