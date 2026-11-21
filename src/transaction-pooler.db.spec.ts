import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool, type PoolClient } from 'pg';

import { CommitRolledBackError } from './commit-rolled-back.error';
import { ISOLATION_LEVEL } from './constants/isolation-level.constant';
import { SESSION_STATE_KIND } from './constants/session-state-kind.constant';
import { ManualTransactionControlError } from './manual-transaction-control.error';
import { PoolerIncompatibleError } from './pooler-incompatible.error';
import { SessionStateLeakError } from './session-state-leak.error';
import { createTestDatabase } from './testing/test-database';
import { transactionKeepingFailure } from './transaction-keeping-failure';
import { withAdvisoryLock } from './with-advisory-lock';
import { withSessionAdvisoryLock } from './with-session-advisory-lock';
import { withTenant } from './with-tenant';

const adminUrl = process.env.PG_TEST_URL;
const poolerUrl = process.env.PG_POOLER_URL;
const describePooler = adminUrl && poolerUrl ? describe : describe.skip;

jest.setTimeout(30_000);

/**
 * Настоящий PgBouncer в transaction mode (`scripts/with-pgbouncer.sh`): у пулера
 * ОДНО серверное соединение на базу, и всё сессионное, что оставила наша
 * транзакция, видит следующий клиент пулера — «сосед». У каждого теста своя
 * база, то есть своё серверное соединение пулера: тесты не видят друг друга.
 */
describePooler('transactionPooler на настоящем PgBouncer [нужны PG_TEST_URL и PG_POOLER_URL]', () => {
  const role = `pooler_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let database: { url: string; drop(): Promise<void> };
  let pool: Pool;
  let url: string;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE ROLE ${role} NOLOGIN`);
    await admin.end();
  });
  afterAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });
  beforeEach(async () => {
    database = await createTestDatabase(adminUrl as string, [
      'CREATE TABLE rows (v int NOT NULL)',
      `GRANT ALL ON rows TO ${role}`,
    ]);
    const target = new URL(poolerUrl as string);
    target.pathname = new URL(database.url).pathname;
    url = target.toString();
    pool = new Pool({ connectionString: url, max: 2 });
  });
  afterEach(async () => {
    await pool?.end();
    await database?.drop();
  });

  /** Запрос соседа: отдельный клиент пулера, вне наших транзакций. */
  const neighbor = async <R>(text: string): Promise<{ row: R; pid: number }> => {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      const { rows } = await client.query(`SELECT pg_backend_pid() AS pid, * FROM (${text}) AS probe`);
      const { pid, ...row } = rows[0] as { pid: number } & Record<string, unknown>;
      return { row: row as R, pid };
    } finally {
      await client.end();
    }
  };

  const run = <T>(work: (tx: never, client: PoolClient) => Promise<T>, options = {}) =>
    transactionKeepingFailure(drizzle(pool), work as never, { transactionPooler: true, ...options }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );

  const ourPid = async (): Promise<number> =>
    transactionKeepingFailure(
      drizzle(pool),
      async (_tx, client) =>
        (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid,
      { transactionPooler: true },
    ) as Promise<number>;

  // Формы, которых текст запроса не видит (EXECUTE строки в DO-блоке): их ловит
  // сверка состояния серверного соединения после транзакции.
  it.each([
    [
      "DO $$BEGIN EXECUTE 'SET search_path = ' || 'leaked'; END$$",
      SESSION_STATE_KIND.setting,
      'search_path = leaked',
    ],
    [
      "DO $$BEGIN EXECUTE 'SELECT set_config(''work_mem'', ''7MB'', ' || 'false)'; END$$",
      SESSION_STATE_KIND.setting,
      'work_mem = 7168',
    ],
    [
      "DO $$BEGIN EXECUTE 'CREATE TEMP TABLE leak_' || 't (x int)'; END$$",
      SESSION_STATE_KIND.temporaryObject,
      'leak_t',
    ],
    [
      "DO $$BEGIN EXECUTE 'LISTEN leak_' || 'channel'; END$$",
      SESSION_STATE_KIND.listenChannel,
      'leak_channel',
    ],
    [
      "DO $$BEGIN EXECUTE 'SELECT pg_advisory_' || 'lock(4242)'; END$$",
      SESSION_STATE_KIND.advisoryLock,
      ':4242:',
    ],
  ])(
    'сверка: %s — SessionStateLeakError после COMMIT, работа зафиксирована',
    async (statement, kind, item) => {
      const outcome = await run(async (_tx, client) => {
        await client.query('INSERT INTO public.rows VALUES (1)');
        await client.query(statement);
      });
      expect(outcome).toEqual({ error: expect.any(SessionStateLeakError) });
      const error = (outcome as { error: SessionStateLeakError }).error;
      expect([error.committed, error.verified]).toEqual([true, true]);
      expect(error.changes).toEqual([
        expect.objectContaining({ kind, change: 'appeared', item: expect.stringContaining(item) }),
      ]);
      const written = await neighbor<{ n: number }>('SELECT count(*)::int AS n FROM public.rows');
      expect(written.row).toEqual({ n: 1 });
    },
  );

  it('сверка: роль сессии (SET ROLE изнутри DO) — SessionStateLeakError', async () => {
    const outcome = await run(async (_tx, client) =>
      client.query(`DO $$BEGIN EXECUTE 'SET ROLE ${role}'; END$$`),
    );
    const error = (outcome as { error: SessionStateLeakError }).error;
    expect(error).toBeInstanceOf(SessionStateLeakError);
    expect(error.changes.map(({ kind, change }) => [kind, change])).toEqual([
      [SESSION_STATE_KIND.role, 'appeared'],
      [SESSION_STATE_KIND.role, 'disappeared'],
    ]);
  });

  it('сверка после ROLLBACK: работа взяла сессионный лок и отказала — SessionStateLeakError, отказ работы в cause', async () => {
    const failure = new Error('отказ работы');
    const outcome = await run(async (_tx, client) => {
      await client.query("DO $$BEGIN EXECUTE 'SELECT pg_advisory_' || 'lock(77)'; END$$");
      throw failure;
    });
    const error = (outcome as { error: SessionStateLeakError }).error;
    expect(error).toBeInstanceOf(SessionStateLeakError);
    expect([error.committed, error.cause]).toEqual([false, failure]);
    expect(error.changes).toEqual([
      expect.objectContaining({
        kind: SESSION_STATE_KIND.advisoryLock,
        item: expect.stringContaining(':77:'),
      }),
    ]);
  });

  it('повтор не повторяет SessionStateLeakError даже с retry.when → true: работа выполнена один раз', async () => {
    let calls = 0;
    const outcome = await run(
      async (_tx, client) => {
        calls += 1;
        await client.query("DO $$BEGIN EXECUTE 'LISTEN again_' || 'channel'; END$$");
      },
      { retry: { attempts: 3, backoffMs: 1, when: () => true } },
    );
    expect([calls, (outcome as { error: unknown }).error instanceof SessionStateLeakError]).toEqual([
      1,
      true,
    ]);
  });

  it('законные формы проходят и сверку, и фильтр: SET LOCAL, set_config(…, true) литералом и параметром, ON COMMIT DROP, xact-лок, localSettings, withTenant, SERIALIZABLE', async () => {
    const outcome = await run(
      async (tx: never, client) => {
        await client.query("SET LOCAL search_path = 'public'");
        await client.query("SELECT set_config('app.a', '1', true)");
        await client.query('SELECT set_config($1, $2, $3)', ['app.b', '2', true]);
        await client.query('CREATE TEMP TABLE scratch (x int) ON COMMIT DROP');
        await client.query('INSERT INTO scratch VALUES (1)');
        await client.query('SELECT pg_advisory_xact_lock(1)');
        await client.query('DECLARE c CURSOR FOR SELECT 1');
        await withTenant(tx as never, 'tenant-a');
        const { rows } = await client.query<{ tenant: string }>(
          "SELECT current_setting('app.tenant_id') AS tenant",
        );
        return rows[0]?.tenant;
      },
      { isolationLevel: ISOLATION_LEVEL.serializable, lockTimeoutMs: 1_000, localSettings: { 'app.c': '3' } },
    );
    expect(outcome).toEqual({ value: 'tenant-a' });
  });

  it('чужое состояние до нашей транзакции не вменяется: сосед оставил SET и LISTEN — наша транзакция проходит', async () => {
    const pid = await ourPid();
    const dirty = new Client({ connectionString: url });
    await dirty.connect();
    try {
      await dirty.query("SET search_path = 'neighbor'; LISTEN neighbor_channel");
      const { rows } = await dirty.query<{ pid: number; path: string }>(
        "SELECT pg_backend_pid() AS pid, current_setting('search_path') AS path",
      );
      expect(rows[0]).toEqual({ pid, path: 'neighbor' });
    } finally {
      await dirty.end();
    }
    const outcome = await run(async (_tx, client) => client.query('INSERT INTO public.rows VALUES (2)'));
    expect(outcome).toEqual({ value: expect.anything() });
  });

  it('advisory-локи: withAdvisoryLock (xact) под пулером проходит, withSessionAdvisoryLock с transactionPooler — отказ до соединения', async () => {
    const value = await withAdvisoryLock(drizzle(pool), 'job', async () => 'locked', {
      timeoutMs: 1_000,
      transactionPooler: true,
    });
    expect(value).toBe('locked');
    const before = pool.totalCount;
    await expect(
      withSessionAdvisoryLock(drizzle(pool), 'job', async () => 'never', {
        timeoutMs: 1_000,
        transactionPooler: true,
      }),
    ).rejects.toBeInstanceOf(PoolerIncompatibleError);
    expect(pool.totalCount).toBe(before);
    const locks = await neighbor<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()",
    );
    expect(locks.row).toEqual({ n: 0 });
  });

  /** Сосед занимает освободившееся серверное соединение и оставляет на нём параметр. */
  const neighborDirties = async (): Promise<void> => {
    const dirty = new Client({ connectionString: url });
    await dirty.connect();
    try {
      await dirty.query("SET search_path = 'between'");
    } finally {
      await dirty.end();
    }
  };

  it('работа сама послала COMMIT, сосед успел изменить освободившееся серверное соединение: ManualTransactionControlError, а не ложная утечка', async () => {
    const outcome = await run(async (tx: never) => {
      await (tx as { execute(q: unknown): Promise<unknown> }).execute(sql`COMMIT`);
      await neighborDirties();
    });
    expect(outcome).toEqual({ error: expect.any(ManualTransactionControlError) });
  });

  it('работа сама послала ROLLBACK и отказала, сосед успел изменить серверное соединение: ManualTransactionControlError с исходным отказом в cause, а не ложная утечка', async () => {
    const failure = new Error('отказ после своего ROLLBACK');
    const outcome = await run(async (tx: never) => {
      await (tx as { execute(q: unknown): Promise<unknown> }).execute(sql`ROLLBACK`);
      await neighborDirties();
      throw failure;
    });
    // С 0.9.0: работа сама завершила транзакцию (25P01 на нашем ROLLBACK) — ручное
    // управление, а не её отказ как есть; COMMIT это был или ROLLBACK, по 25P01 не различить.
    expect(outcome).toEqual({ error: expect.any(ManualTransactionControlError) });
    expect(((outcome as { error: Error }).error as Error).cause).toBe(failure);
  });

  /** Подменить текст сверки после COMMIT/ROLLBACK отказывающим запросом (как будто сверка упала). */
  const failProbeAfter = (command: string): void => {
    pool.on('connect', (client: PoolClient) => {
      const original = client.query.bind(client) as (...args: unknown[]) => unknown;
      // biome-ignore lint/suspicious/noExplicitAny: подмена перегруженного метода драйвера
      (client as any).query = (...args: unknown[]): unknown => {
        const first = args[0] as { text?: unknown; submit?: unknown };
        if (typeof first?.submit === 'function' && String(first.text).startsWith(`${command};`)) {
          first.text = `${command}; SELECT 1/0`;
        }
        return original(...args);
      };
    });
  };

  it('сверка после COMMIT отказала: SessionStateLeakError verified=false, committed=true — а не «отказ COMMIT, не записано»', async () => {
    failProbeAfter('COMMIT');
    const outcome = await run(async (_tx, client) => client.query('INSERT INTO public.rows VALUES (3)'));
    const error = (outcome as { error: SessionStateLeakError }).error;
    expect(error).toBeInstanceOf(SessionStateLeakError);
    expect([error.verified, error.committed, (error.probeError as { code?: string }).code]).toEqual([
      false,
      true,
      '22012',
    ]);
    expect((await neighbor<{ n: number }>('SELECT count(*)::int AS n FROM public.rows')).row).toEqual({
      n: 1,
    });
  });

  it('сверка после ROLLBACK отказала: SessionStateLeakError verified=false, отказ работы в cause, соединение не уничтожено', async () => {
    failProbeAfter('ROLLBACK');
    const destroyed: unknown[] = [];
    const failure = new Error('отказ работы');
    const outcome = await run(
      async () => {
        throw failure;
      },
      { observer: { connectionDestroyed: (event: unknown) => destroyed.push(event) } },
    );
    const error = (outcome as { error: SessionStateLeakError }).error;
    expect(error).toBeInstanceOf(SessionStateLeakError);
    expect([error.verified, error.committed, error.cause]).toEqual([false, false, failure]);
    expect(destroyed).toEqual([]);
  });

  it('отказ самого COMMIT (отложенное ограничение): исходный отказ; ROLLBACK после него — без сверки (транзакции уже нет)', async () => {
    const admin = new Client({ connectionString: database.url });
    await admin.connect();
    await admin.query(
      'CREATE TABLE parent (id int PRIMARY KEY); ' +
        'CREATE TABLE child (parent int REFERENCES parent (id) DEFERRABLE INITIALLY DEFERRED)',
    );
    await admin.end();
    const sent: string[] = [];
    pool.on('connect', (client: PoolClient) => {
      const original = client.query.bind(client) as (...args: unknown[]) => unknown;
      // biome-ignore lint/suspicious/noExplicitAny: подмена перегруженного метода драйвера
      (client as any).query = (...args: unknown[]): unknown => {
        const first = args[0] as string | { text?: string };
        sent.push(typeof first === 'string' ? first : String(first.text));
        return original(...args);
      };
    });
    const outcome = await run(async (_tx, client) => client.query('INSERT INTO child VALUES (1)'));
    expect((outcome as { error: { code?: string } }).error.code).toBe('23503');
    expect(sent.filter((text) => text.startsWith('ROLLBACK'))).toEqual(['ROLLBACK']);
  });

  it('проглоченный отказ запроса (COMMIT ответил ROLLBACK) без утечки — CommitRolledBackError, как без пулера', async () => {
    const outcome = await run(async (_tx, client) => {
      await client.query('SELECT 1/0').catch(() => undefined);
    });
    expect(outcome).toEqual({ error: expect.any(CommitRolledBackError) });
  });

  it('SET TRANSACTION ISOLATION LEVEL первым запросом работы — отказ сервера 25001 (первый запрос — снимок); опция isolationLevel работает', async () => {
    const outcome = await run(async (_tx, client) =>
      client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'),
    );
    expect((outcome as { error: { code?: string } }).error.code).toBe('25001');
    const level = await run(
      async (_tx, client) =>
        (await client.query<{ level: string }>("SELECT current_setting('transaction_isolation') AS level"))
          .rows[0]?.level,
      { isolationLevel: ISOLATION_LEVEL.serializable },
    );
    expect(level).toEqual({ value: 'serializable' });
  });

  it('sessionStateCheck: false — остаётся только фильтр текста: обход через DO проходит, BEGIN и COMMIT без снимков', async () => {
    const sent: string[] = [];
    pool.on('connect', (client: PoolClient) => {
      const original = client.query.bind(client) as (...args: unknown[]) => unknown;
      // biome-ignore lint/suspicious/noExplicitAny: подмена перегруженного метода драйвера
      (client as any).query = (...args: unknown[]): unknown => {
        const first = args[0] as string | { text?: string };
        sent.push(typeof first === 'string' ? first : String(first.text));
        return original(...args);
      };
    });
    const outcome = await run(
      async (_tx, client) => client.query("DO $$BEGIN EXECUTE 'LISTEN unchecked'; END$$"),
      {
        sessionStateCheck: false,
      },
    );
    expect(outcome).toEqual({ value: expect.anything() });
    expect(sent.filter((text) => /^(BEGIN|COMMIT)/.test(text))).toEqual(['BEGIN', 'COMMIT']);
    const blocked = await run(async (_tx, client) => client.query('CREATE TEMP TABLE still_text (x int)'), {
      sessionStateCheck: false,
    });
    expect(blocked).toEqual({ error: expect.any(PoolerIncompatibleError) });
  });

  it('sessionStateCheck без transactionPooler — отказ до соединения', async () => {
    await expect(
      transactionKeepingFailure(drizzle(pool), async () => 'x', { sessionStateCheck: true }),
    ).rejects.toThrow('только вместе с transactionPooler');
    expect(pool.totalCount).toBe(0);
  });

  it('отказ работы без утечки — исходный отказ, не обёрнутый', async () => {
    const failure = new Error('просто отказ');
    const outcome = await run(async () => {
      throw failure;
    });
    expect(outcome).toEqual({ error: failure });
  });

  // Под пулером «соединение пула» клиента — не серверная сессия: SET обработчика
  // connect уходит вне транзакции на то серверное соединение, которое пулер дал
  // в тот момент. Параметры, которые сервер сообщает клиенту (ParameterStatus:
  // TimeZone, application_name, DateStyle, …), PgBouncer запоминает за клиентом
  // и выставляет на каждом выданном ему серверном соединении; остальные остаются
  // на серверном соединении — у соседа — и теряются у клиента. Сверка судит
  // разницу внутри транзакции, поэтому ни то ни другое утечкой не считает.
  it('параметры connect под пулером: отслеживаемые пулером — у клиента, прочие — на серверном соединении (сосед их видит); сверка не считает их утечкой', async () => {
    const connectPool = new Pool({ connectionString: url, max: 1 });
    const connectErrors: unknown[] = [];
    connectPool.on('connect', (client: PoolClient) => {
      for (const statement of [
        "SET TIME ZONE 'Asia/Tokyo'",
        "SET application_name = 'conn-app'",
        "SET statement_timeout = '7s'",
      ]) {
        (client.query(statement) as unknown as Promise<unknown>).catch((error) => connectErrors.push(error));
      }
    });
    const SETTINGS =
      "SELECT current_setting('TimeZone') AS tz, current_setting('application_name') AS app, current_setting('statement_timeout') AS st";
    const read = () =>
      transactionKeepingFailure(
        drizzle(connectPool),
        async (_tx, client) =>
          (await client.query<{ tz: string; app: string; st: string }>(SETTINGS)).rows[0],
        { transactionPooler: true },
      );
    try {
      expect(await read()).toEqual({ tz: 'Asia/Tokyo', app: 'conn-app', st: '7s' });
      const seen = await neighbor<{ tz: string; app: string; st: string }>(SETTINGS);
      expect([seen.row.tz === 'Asia/Tokyo', seen.row.app, seen.row.st]).toEqual([false, '', '7s']);
      const other = new Client({ connectionString: url });
      await other.connect();
      try {
        await other.query("SET statement_timeout = '3s'");
      } finally {
        await other.end();
      }
      // Отслеживаемые вернулись к клиенту, неотслеживаемый — чужой; утечки сверка не видит.
      expect(await read()).toEqual({ tz: 'Asia/Tokyo', app: 'conn-app', st: '3s' });
      expect(connectErrors).toEqual([]);
    } finally {
      await connectPool.end();
    }
  });
});
