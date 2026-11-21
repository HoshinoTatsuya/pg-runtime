import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool, type PoolClient } from 'pg';

import { NESTED_TRANSACTION } from './constants/nested-transaction.constant';
import { SESSION_BASELINE } from './constants/session-baseline.constant';
import { SESSION_STATE_KIND } from './constants/session-state-kind.constant';
import { SessionStateLeakError } from './session-state-leak.error';
import { createTestDatabase } from './testing/test-database';
import { withinSeconds } from './testing/within-seconds';
import { transactionKeepingFailure } from './transaction-keeping-failure';
import type { TransactionOptions } from './types/transaction-options.type';

const adminUrl = process.env.PG_TEST_URL;
const describeDb = adminUrl ? describe : describe.skip;

jest.setTimeout(30_000);

/** Что видит транзакция на соединении: параметры каждого источника, роль, подписки, схема неквалифицированного имени. */
interface Seen {
  readonly searchPath: string;
  readonly timeZone: string;
  readonly applicationName: string;
  readonly lockTimeout: string;
  readonly workMem: string;
  readonly statementTimeout: string;
  readonly currentUser: string;
  readonly channels: readonly string[];
  readonly appConnect: string;
  readonly appStartup: string;
  readonly appWork: string;
  readonly unqualified: string;
}

const SEEN_SQL = `SELECT current_setting('search_path') AS "searchPath",
  current_setting('TimeZone') AS "timeZone",
  current_setting('application_name') AS "applicationName",
  current_setting('lock_timeout') AS "lockTimeout",
  current_setting('work_mem') AS "workMem",
  current_setting('statement_timeout') AS "statementTimeout",
  current_user::text AS "currentUser",
  ARRAY(SELECT c::text FROM pg_listening_channels() AS c ORDER BY 1) AS channels,
  coalesce(current_setting('app.conn', true), '') AS "appConnect",
  coalesce(current_setting('app.start', true), '') AS "appStartup",
  coalesce(current_setting('app.work', true), '') AS "appWork",
  (SELECT v FROM t) AS unqualified`;

/**
 * Базовая линия уборки сессии (`resetSession` + `sessionBaseline`): параметры,
 * которые приложение задаёт соединению в `pool.on('connect')`, переживают
 * уборку, а сменённые работой — откатываются. Пул max=1: каждая следующая
 * транзакция получает то же соединение.
 *
 * Источники параметров (у каждого свой параметр, чтобы их нельзя было спутать):
 * стартовый пакет (`application_name`, `options: -c lock_timeout / app.start`),
 * `ALTER ROLE … SET work_mem`, `ALTER DATABASE … SET statement_timeout`,
 * connect (`SET search_path`, `SET TIME ZONE`, `SET ROLE`, `LISTEN`, `SET app.conn`),
 * работа (`set_config(…, false)` каждого из них).
 */
describeDb('resetSession: базовая линия connect [нужен PG_TEST_URL]', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const login = `bl_login_${suffix}`;
  const rls = `bl_rls_${suffix}`;
  let database: { url: string; drop(): Promise<void> };
  let loginUrl: string;
  const pools: Pool[] = [];

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE ROLE ${login} LOGIN PASSWORD 'p'`);
    await admin.query(`CREATE ROLE ${rls} NOLOGIN`);
    await admin.query(`GRANT ${rls} TO ${login}`);
    await admin.query(`ALTER ROLE ${login} SET work_mem = '7MB'`);
    await admin.end();
    database = await createTestDatabase(adminUrl as string, [
      'CREATE SCHEMA app',
      "CREATE TABLE public.t (v text); INSERT INTO public.t VALUES ('public')",
      "CREATE TABLE app.t (v text); INSERT INTO app.t VALUES ('app')",
      `GRANT USAGE ON SCHEMA app TO ${login}, ${rls}`,
      `GRANT SELECT ON public.t, app.t TO ${login}, ${rls}`,
    ]);
    const dbName = new URL(database.url).pathname.slice(1);
    const setup = new Client({ connectionString: database.url });
    await setup.connect();
    await setup.query(`ALTER DATABASE ${dbName} SET statement_timeout = '11s'`);
    await setup.end();
    const url = new URL(database.url);
    url.username = login;
    url.password = 'p';
    loginUrl = url.toString();
  });
  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
  });
  afterAll(async () => {
    await database?.drop();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP ROLE IF EXISTS ${login}`);
    await admin.query(`DROP ROLE IF EXISTS ${rls}`);
    await admin.end();
  });

  /** Стартовый пакет: `application_name` и `options` — у всех соединений набора. */
  const STARTUP = { application_name: 'startup-app', options: '-c lock_timeout=13s -c app.start=s' };

  /** Обработчик connect, как в документации pg-pool: запросы ставятся в очередь синхронно. */
  const CONNECT_SQL = [
    'SET search_path TO app, public',
    "SET TIME ZONE 'Asia/Tokyo'",
    'SET ROLE <rls>',
    'LISTEN conn_ch',
    "SET app.conn = 'c'",
  ];

  /** Пул max=1 с обработчиком connect; `sent` — тексты всех запросов соединения. */
  const poolWithConnect = (connectSql: readonly string[] = CONNECT_SQL) => {
    const pool = new Pool({ connectionString: loginUrl, max: 1, ...STARTUP });
    pools.push(pool);
    const sent: string[] = [];
    // Уборка, которая не прошла, уничтожает соединение, а новое снова проходит
    // connect — и выглядело бы восстановленным. Второе соединение — ошибка теста.
    const connectErrors: unknown[] = [];
    let connections = 0;
    pool.on('connect', (client: PoolClient) => {
      connections += 1;
      if (connections > 1) {
        connectErrors.push(new Error(`соединение №${connections}: прежнее уничтожено`));
      }
      const original = client.query.bind(client) as (...args: unknown[]) => unknown;
      // biome-ignore lint/suspicious/noExplicitAny: подмена перегруженного метода драйвера
      (client as any).query = (...args: unknown[]): unknown => {
        const first = args[0] as string | { text?: string };
        sent.push(typeof first === 'string' ? first : (first.text ?? ''));
        return original(...args);
      };
      for (const statement of connectSql) {
        (client.query(statement.replaceAll('<rls>', rls)) as unknown as Promise<unknown>).catch((error) =>
          connectErrors.push(error),
        );
      }
    });
    return { pool, sent, connectErrors };
  };

  const seen = (pool: Pool, options: TransactionOptions = {}): Promise<Seen> =>
    transactionKeepingFailure(
      drizzle(pool),
      async (_tx, client) => (await client.query<Seen>(SEEN_SQL)).rows[0] as Seen,
      options,
    );

  /** Работа, сменившая параметр каждого источника и сессионное состояние. */
  const dirty = async (_tx: unknown, client: PoolClient): Promise<void> => {
    await client.query(
      `SELECT set_config('search_path', 'public', false), set_config('TimeZone', 'UTC', false),
              set_config('application_name', 'work-app', false), set_config('lock_timeout', '1s', false),
              set_config('work_mem', '1MB', false), set_config('statement_timeout', '1s', false),
              set_config('app.work', 'w', false), set_config('app.conn', 'changed', false)`,
    );
    await client.query('RESET ROLE');
    await client.query('UNLISTEN conn_ch');
    await client.query('LISTEN work_ch');
  };

  /** То, что видит соединение после connect, — до любой работы. */
  const CONNECT_STATE: Seen = {
    searchPath: 'app, public',
    timeZone: 'Asia/Tokyo',
    applicationName: 'startup-app',
    lockTimeout: '13s',
    workMem: '7MB',
    statementTimeout: '11s',
    currentUser: '<rls>',
    channels: ['conn_ch'],
    appConnect: 'c',
    appStartup: 's',
    appWork: '',
    unqualified: 'app',
  };
  const connectState = (): Seen => ({ ...CONNECT_STATE, currentUser: rls });

  /** Значения по умолчанию сессии того же пользователя с тем же стартовым пакетом — без connect. */
  const defaultsState = async (): Promise<Seen> => {
    const client = new Client({ connectionString: loginUrl, ...STARTUP });
    await client.connect();
    try {
      return (await client.query<Seen>(SEEN_SQL)).rows[0] as Seen;
    } finally {
      await client.end();
    }
  };

  it('находка: после уборки параметры connect на месте — неквалифицированное имя разрешается в ту же схему', async () => {
    const { pool, connectErrors } = poolWithConnect();
    expect(await seen(pool, { resetSession: true })).toEqual(connectState());
    await transactionKeepingFailure(drizzle(pool), async () => 'чистая работа', { resetSession: true });
    // Свой параметр, заданный на connect (`app.conn`), уборка вернуть не может:
    // Postgres не показывает свои параметры в pg_settings — ограничение, названо в README.
    expect(await seen(pool, { resetSession: true })).toEqual({ ...connectState(), appConnect: '' });
    expect([connectErrors, pool.totalCount]).toEqual([[], 1]);
  });

  it('двойник: что сменила РАБОТА — уборка откатывает к состоянию после connect (и после успеха, и после отказа)', async () => {
    const { pool, connectErrors } = poolWithConnect();
    await transactionKeepingFailure(drizzle(pool), dirty, { resetSession: true });
    // Свой параметр, заданный на connect (`app.conn`), уборка вернуть не может:
    // Postgres не показывает свои параметры в pg_settings — ограничение, названо в README.
    expect(await seen(pool)).toEqual({ ...connectState(), appConnect: '' });
    await transactionKeepingFailure(
      drizzle(pool),
      async (tx, client) => {
        await dirty(tx, client);
        throw new Error('отказ работы');
      },
      { resetSession: true },
    ).catch(() => undefined);
    expect(await seen(pool)).toEqual({ ...connectState(), appConnect: '' });
    expect([connectErrors, pool.totalCount]).toEqual([[], 1]);
  });

  it('без уборки то, что сменила работа, уезжает следующему владельцу (контроль: работа действительно меняет каждый параметр)', async () => {
    const { pool } = poolWithConnect();
    await transactionKeepingFailure(drizzle(pool), dirty);
    expect(await seen(pool)).toEqual({
      searchPath: 'public',
      timeZone: 'UTC',
      applicationName: 'work-app',
      lockTimeout: '1s',
      workMem: '1MB',
      statementTimeout: '1s',
      currentUser: login,
      channels: ['work_ch'],
      appConnect: 'changed',
      appStartup: 's',
      appWork: 'w',
      unqualified: 'public',
    });
  });

  it("sessionBaseline: 'defaults' — к значениям по умолчанию сессии: стартовый пакет и ALTER ROLE/DATABASE остаются, connect теряется", async () => {
    const { pool, connectErrors } = poolWithConnect();
    const defaults = await defaultsState();
    // Контроль: значения по умолчанию отличаются от connect в каждом параметре connect.
    expect(defaults).toEqual({
      ...connectState(),
      searchPath: '"$user", public',
      timeZone: defaults.timeZone,
      currentUser: login,
      channels: [],
      appConnect: '',
      unqualified: 'public',
    });
    expect(defaults.timeZone).not.toBe('Asia/Tokyo');
    await transactionKeepingFailure(drizzle(pool), dirty, {
      resetSession: true,
      sessionBaseline: SESSION_BASELINE.defaults,
    });
    expect([await seen(pool), connectErrors]).toEqual([defaults, []]);
  });

  it('снимок — один раз на соединение, тем же сообщением, что BEGIN; без уборки и с defaults — ни одного', async () => {
    const isSnapshot = (text: string): boolean => text.includes('pg_settings');
    const connect = poolWithConnect();
    for (let round = 0; round < 5; round += 1) {
      await transactionKeepingFailure(drizzle(connect.pool), dirty, { resetSession: true });
    }
    expect(connect.sent.filter(isSnapshot).map((text) => text.split(';')[0])).toEqual(['BEGIN']);
    // Лишних обращений к базе нет: BEGIN (со снимком), работа, COMMIT, уборка — на каждую транзакцию.
    expect(connect.sent.filter((text) => /^(BEGIN|COMMIT|CLOSE ALL)/.test(text)).length).toBe(15);

    const defaults = poolWithConnect();
    await transactionKeepingFailure(drizzle(defaults.pool), dirty, {
      resetSession: true,
      sessionBaseline: SESSION_BASELINE.defaults,
    });
    const plain = poolWithConnect();
    await transactionKeepingFailure(drizzle(plain.pool), dirty);
    expect([defaults.sent.filter(isSnapshot), plain.sent.filter(isSnapshot)]).toEqual([[], []]);
    expect([connect.connectErrors, defaults.connectErrors]).toEqual([[], []]);
  });

  it('снимок — у каждого соединения свой: базовая линия одного соединения не переносится на другое', async () => {
    const first = poolWithConnect(['SET search_path TO app, public']);
    await transactionKeepingFailure(drizzle(first.pool), dirty, { resetSession: true });
    const second = poolWithConnect(["SET TIME ZONE 'Asia/Tokyo'"]);
    await transactionKeepingFailure(drizzle(second.pool), dirty, { resetSession: true });
    const [a, b] = [await seen(first.pool), await seen(second.pool)];
    expect([a.searchPath, a.timeZone === 'Asia/Tokyo', b.searchPath, b.timeZone]).toEqual([
      'app, public',
      false,
      '"$user", public',
      'Asia/Tokyo',
    ]);
    expect([first.connectErrors, second.connectErrors]).toEqual([[], []]);
  });

  it('значения с кавычками, $-метками и обратной косой восстанавливаются как были', async () => {
    const name = String.raw`a = 'b$q$c\d$q`;
    const { pool, connectErrors } = poolWithConnect([
      `SET application_name = ${`'${name.replaceAll("'", "''")}'`}`,
      'SET search_path TO "we$q$ird", app',
    ]);
    const read = () =>
      transactionKeepingFailure(
        drizzle(pool),
        async (_tx, client) =>
          (
            await client.query<{ app: string; path: string }>(
              "SELECT current_setting('application_name') AS app, current_setting('search_path') AS path",
            )
          ).rows[0],
        { resetSession: true },
      );
    const before = await read();
    expect(before).toEqual({ app: name, path: '"we$q$ird", app' });
    await transactionKeepingFailure(drizzle(pool), dirty, { resetSession: true });
    expect([await read(), connectErrors]).toEqual([before, []]);
  });

  it('LISTEN с connect переживает уборку: уведомление после неё доходит до соединения, канал работы снят', async () => {
    const { pool, connectErrors } = poolWithConnect(['LISTEN "Conn Ch"']);
    await transactionKeepingFailure(drizzle(pool), dirty, { resetSession: true });
    const payloads: string[] = [];
    // Работа получала защищённое соединение; уведомления приходят на соединение пула.
    const raw = await pool.connect();
    const received = new Promise<void>((resolve) => {
      raw.on('notification', (message) => {
        payloads.push(message.payload ?? '');
        resolve();
      });
    });
    raw.release();
    const sender = new Client({ connectionString: database.url });
    await sender.connect();
    try {
      // Канал работы — первым: будь он ещё подписан, его уведомление пришло бы раньше.
      await sender.query(`NOTIFY work_ch, 'канал работы'`);
      await sender.query(`NOTIFY "Conn Ch", 'после уборки'`);
    } finally {
      await sender.end();
    }
    await withinSeconds(10, received);
    expect([payloads, connectErrors]).toEqual([['после уборки'], []]);
  });

  it.each([
    ['временная таблица', 'CREATE TEMP TABLE conn_tmp (x int)', SESSION_STATE_KIND.temporaryObject],
    ['сессионный advisory-лок', 'SELECT pg_advisory_lock(5151)', SESSION_STATE_KIND.advisoryLock],
    [
      'курсор WITH HOLD',
      'BEGIN; DECLARE conn_cur CURSOR WITH HOLD FOR SELECT 1; COMMIT',
      SESSION_STATE_KIND.holdableCursor,
    ],
  ])(
    '%s с connect: уборка к connect — отказ до работы (не тихая потеря), defaults — работает',
    async (_label, statement, kind) => {
      const refused = poolWithConnect([statement]);
      let ran = false;
      const outcome = await transactionKeepingFailure(
        drizzle(refused.pool),
        async () => {
          ran = true;
        },
        { resetSession: true },
      ).catch((error: unknown) => error);
      expect([ran, (outcome as Error).message]).toEqual([false, expect.stringContaining(`${kind}: `)]);
      expect((outcome as Error).message).toContain(
        'resetSession не вернёт соединение к состоянию после connect',
      );

      const allowed = poolWithConnect([statement]);
      expect(
        await transactionKeepingFailure(drizzle(allowed.pool), async () => 'ok', {
          resetSession: true,
          sessionBaseline: SESSION_BASELINE.defaults,
        }),
      ).toBe('ok');
    },
  );

  it('SET SESSION AUTHORIZATION и SET ROLE с connect (пул суперпользователя): уборка возвращает обоих', async () => {
    const pool = new Pool({ connectionString: database.url, max: 1 });
    pools.push(pool);
    const connectErrors: unknown[] = [];
    pool.on('connect', (client: PoolClient) => {
      connectErrors.push('connect');
      for (const statement of [`SET SESSION AUTHORIZATION ${login}`, `SET ROLE ${rls}`]) {
        (client.query(statement) as unknown as Promise<unknown>).catch((error) => connectErrors.push(error));
      }
    });
    const users = () =>
      transactionKeepingFailure(
        drizzle(pool),
        async (_tx, client) =>
          (
            await client.query<{ session: string; current: string }>(
              'SELECT session_user::text AS session, current_user::text AS current',
            )
          ).rows[0],
        { resetSession: true },
      );
    expect(await users()).toEqual({ session: login, current: rls });
    await transactionKeepingFailure(
      drizzle(pool),
      async (_tx, client) => {
        await client.query('SET SESSION AUTHORIZATION DEFAULT');
      },
      { resetSession: true },
    );
    expect(await users()).toEqual({ session: login, current: rls });
    // Одно соединение на все транзакции: уборка прошла, а не соединение пересоздано.
    expect(connectErrors).toEqual(['connect']);
  });

  it('подготовленный оператор с connect не мешает: уборка его не снимает', async () => {
    const { pool, connectErrors } = poolWithConnect(['PREPARE conn_stmt AS SELECT 41 + 1 AS n']);
    for (let round = 0; round < 2; round += 1) {
      const n = await transactionKeepingFailure(
        drizzle(pool),
        async (_tx, client) => (await client.query<{ n: number }>('EXECUTE conn_stmt')).rows[0]?.n,
        { resetSession: true },
      );
      expect(n).toBe(42);
    }
    expect(connectErrors).toEqual([]);
  });

  it('sessionBaseline без resetSession, неизвестное значение, под точкой сохранения — отказ до соединения', async () => {
    const pool = new Pool({ connectionString: loginUrl, max: 1 });
    pools.push(pool);
    await expect(
      transactionKeepingFailure(drizzle(pool), async () => 'x', {
        sessionBaseline: SESSION_BASELINE.connect,
      }),
    ).rejects.toThrow('sessionBaseline — только вместе с resetSession');
    await expect(
      transactionKeepingFailure(drizzle(pool), async () => 'x', {
        resetSession: true,
        sessionBaseline: 'session' as never,
      }),
    ).rejects.toThrow('sessionBaseline — connect | defaults');
    expect(pool.totalCount).toBe(0);
    const nested = await transactionKeepingFailure(drizzle(pool), async () =>
      transactionKeepingFailure(drizzle(pool), async () => 'inner', {
        nested: NESTED_TRANSACTION.savepoint,
        sessionBaseline: SESSION_BASELINE.defaults,
      }).catch((error: Error) => error.message),
    );
    expect(nested).toContain('sessionBaseline');
  });

  it('transactionPooler: параметры connect — не утечка (они в обоих снимках), работа в обход текста — утечка', async () => {
    const { pool } = poolWithConnect();
    for (let round = 0; round < 3; round += 1) {
      expect(await seen(pool, { transactionPooler: true })).toEqual(connectState());
    }
    const leaked = await transactionKeepingFailure(
      drizzle(pool),
      async (_tx, client) => client.query("DO $$BEGIN EXECUTE 'SET search_path = ' || 'public'; END$$"),
      { transactionPooler: true },
    ).catch((error: unknown) => error);
    expect(leaked).toBeInstanceOf(SessionStateLeakError);
    expect((leaked as SessionStateLeakError).changes).toEqual([
      { kind: SESSION_STATE_KIND.setting, item: 'search_path = public', change: 'appeared' },
      { kind: SESSION_STATE_KIND.setting, item: 'search_path = app, public', change: 'disappeared' },
    ]);
  });
});
