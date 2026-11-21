import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool, type PoolClient } from 'pg';

import { APP_SETTINGS_RESET_SQL } from './constants/app-settings-reset.constant';
import { CLIENT_MISUSE } from './constants/client-misuse.constant';
import { NESTED_TRANSACTION } from './constants/nested-transaction.constant';
import { RETRY_REASON } from './constants/retry-reason.constant';
import { SESSION_BASELINE } from './constants/session-baseline.constant';
import { SESSION_PROBE_SQL } from './constants/session-probe.constant';
import { TRANSACTION_STAGE } from './constants/transaction-stage.constant';
import { isConnectionFailure } from './is-connection-failure';
import { ManualTransactionControlError } from './manual-transaction-control.error';
import { PoolerIncompatibleError } from './pooler-incompatible.error';
import { createTestDatabase } from './testing/test-database';
import { withinSeconds } from './testing/within-seconds';
import { TransactionClientMisuseError } from './transaction-client-misuse.error';
import { transactionKeepingFailure } from './transaction-keeping-failure';
import type { TransactionObserver } from './types/transaction-observer.type';
import { withTenant } from './with-tenant';

const adminUrl = process.env.PG_TEST_URL;
const describeDb = adminUrl ? describe : describe.skip;

jest.setTimeout(30_000);

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Наблюдатель, записывающий события строками. */
const recorder = (): { events: string[]; observer: TransactionObserver } => {
  const events: string[] = [];
  return {
    events,
    observer: {
      connectionAcquired: () => events.push('acquired'),
      attemptFailed: ({ attempt, stage, willRetry }) =>
        events.push(`failed ${attempt} ${stage} ${willRetry}`),
      connectionDestroyed: ({ stage }) => events.push(`destroyed ${stage}`),
    },
  };
};

/**
 * Краевые случаи транзакции на настоящей базе: распоряжение соединением из
 * работы, опции под точкой сохранения, стадия отказов запросов пакета внутри
 * транзакции, базовая линия роли и формы, о которых судит сам сервер.
 */
describeDb('transactionKeepingFailure: краевые случаи [нужен PG_TEST_URL]', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const login = `edge_login_${suffix}`;
  const group = `edge_group_${suffix}`;
  let database: { url: string; drop(): Promise<void> };
  const pools: Pool[] = [];

  beforeAll(async () => {
    database = await createTestDatabase(adminUrl as string, ['CREATE TABLE edge (name text PRIMARY KEY)']);
    const admin = new Client({ connectionString: database.url });
    await admin.connect();
    try {
      await admin.query(`CREATE ROLE ${group} NOLOGIN`);
      await admin.query(`CREATE ROLE ${login} LOGIN PASSWORD 'p' IN ROLE ${group}`);
      await admin.query(`ALTER ROLE ${login} SET role = '${group}'`);
      await admin.query(`GRANT ALL ON edge TO ${group}`);
    } finally {
      await admin.end();
    }
  });
  afterAll(async () => {
    for (const pool of pools) {
      await pool.end().catch(() => undefined);
    }
    await database?.drop();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP ROLE IF EXISTS ${login}`);
    await admin.query(`DROP ROLE IF EXISTS ${group}`);
    await admin.end();
  });

  const newPool = (connect: readonly string[] = [], url: string = database.url): Pool => {
    const pool = new Pool({ connectionString: url, max: 1 });
    if (connect.length > 0) {
      pool.on('connect', (client) => {
        for (const statement of connect) {
          void client.query(statement);
        }
      });
    }
    pools.push(pool);
    return pool;
  };
  const names = async (pool: Pool): Promise<string[]> =>
    (await pool.query<{ name: string }>('SELECT name FROM edge ORDER BY name')).rows.map((row) => row.name);

  it.each([
    ['retry по коду 40001', 'code', { attempts: 3 }],
    ['retry.when всегда true', 'when', { attempts: 3, on: [], when: () => true }],
  ] as const)(
    'ручной COMMIT, затем throw (%s) — ManualTransactionControlError с ошибкой работы в cause, без повтора',
    async (_name, kind, retry) => {
      const pool = newPool();
      const tag = `manual.throw.${kind}`;
      const { events, observer } = recorder();
      const workError = Object.assign(new Error('сбой после ручного COMMIT'), { code: '40001' });
      let calls = 0;
      const failure = await withinSeconds(
        10,
        transactionKeepingFailure(
          drizzle(pool),
          async (_tx, client) => {
            calls += 1;
            await client.query('INSERT INTO edge VALUES ($1)', [`${tag}.${calls}`]);
            await client.query('COMMIT');
            throw workError;
          },
          { retry: { ...retry, backoffMs: 0 }, observer },
        ),
      ).catch((error: unknown) => error);
      try {
        expect(failure).toBeInstanceOf(ManualTransactionControlError);
        expect((failure as Error).cause).toBe(workError);
        expect(calls).toBe(1);
        expect(events).toEqual(['acquired', 'failed 1 work false']);
        // Часть до ручного COMMIT зафиксирована отдельно — об этом и говорит отказ.
        expect((await names(pool)).filter((name) => name.startsWith(tag))).toEqual([`${tag}.1`]);
        expect([pool.totalCount, pool.idleCount]).toEqual([1, 1]);
      } finally {
        // Таблица общая для набора: зафиксированная часть не должна попасть в чужие проверки.
        await pool.query('DELETE FROM edge WHERE name LIKE $1', [`${tag}.%`]);
      }
    },
  );

  it('client.end() из работы — TransactionClientMisuseError: транзакция откатана ROLLBACK, соединение исправно в пуле', async () => {
    const pool = newPool();
    const failure = await withinSeconds(
      5,
      transactionKeepingFailure(drizzle(pool), async (tx, client) => {
        await tx.execute(sql`INSERT INTO edge VALUES ('end.x')`);
        await client.end();
      }),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TransactionClientMisuseError);
    expect((failure as TransactionClientMisuseError).misuse).toBe(CLIENT_MISUSE.end);
    expect([pool.totalCount, pool.idleCount]).toEqual([1, 1]);
    expect(await names(pool)).toEqual([]);
  });

  it('под точкой сохранения transactionPooler: true без него у внешней — отказ; у внешней задан — защита действует', async () => {
    const pool = newPool();
    const refused = await transactionKeepingFailure(drizzle(pool), () =>
      transactionKeepingFailure(drizzle(pool), async () => 'вложенная', {
        nested: NESTED_TRANSACTION.savepoint,
        transactionPooler: true,
      }),
    ).catch((error: unknown) => error);
    expect((refused as Error).message).toContain('под точкой сохранения transactionPooler: true');
    // Двойник: внешняя под защитой — вложенная с тем же флагом проходит, и SET в ней отвергает фильтр.
    const guarded = await transactionKeepingFailure(
      drizzle(pool),
      () =>
        transactionKeepingFailure(
          drizzle(pool),
          async (_tx, client: PoolClient) => {
            await client.query('SET work_mem = 1024');
          },
          { nested: NESTED_TRANSACTION.savepoint, transactionPooler: true },
        ),
      { transactionPooler: true },
    ).catch((error: unknown) => error);
    expect(guarded).toBeInstanceOf(PoolerIncompatibleError);
    expect([pool.totalCount, pool.idleCount]).toEqual([1, 1]);
  });

  it('observer под точкой сохранения не вызывается (соединение и попытки — внешней), опция не отвергается', async () => {
    const pool = newPool();
    const outer = recorder();
    const inner = recorder();
    await transactionKeepingFailure(
      drizzle(pool),
      () =>
        transactionKeepingFailure(drizzle(pool), async () => 'x', {
          nested: NESTED_TRANSACTION.savepoint,
          observer: inner.observer,
        }),
      { observer: outer.observer },
    );
    expect([outer.events, inner.events]).toEqual([['acquired'], []]);
  });

  it('базовая линия, которую уборка не вернёт (временная таблица с connect), — отказ стадии work: ROLLBACK, без уничтожения и без повтора как обрыва', async () => {
    const pool = newPool(['CREATE TEMP TABLE conn_tmp (x int)']);
    const { events, observer } = recorder();
    const failure = await transactionKeepingFailure(drizzle(pool), async () => 'не дошло', {
      resetSession: true,
      retry: { attempts: 3, on: [RETRY_REASON.connectionBeforeWork], backoffMs: 1 },
      observer,
    }).catch((error: unknown) => error);
    expect((failure as Error).message).toContain(
      'resetSession не вернёт соединение к состоянию после connect',
    );
    expect(events).toEqual(['acquired', `failed 1 ${TRANSACTION_STAGE.work} false`]);
    // Соединение то же (не уничтожено) и без открытой транзакции.
    const state = await pool.query<{ temp: string | null; open: boolean }>(
      "SELECT to_regclass('pg_temp.conn_tmp')::text AS temp, transaction_timestamp() <> statement_timestamp() AS open",
    );
    expect([pool.totalCount, state.rows[0]]).toEqual([1, { temp: 'conn_tmp', open: false }]);
  });

  it('отказ сброса resetAppSettings — стадия work (транзакция ещё открыта): ROLLBACK, запись не зафиксирована, соединение исправно', async () => {
    const pool = newPool();
    pool.on('connect', (client) => {
      const original = client.query.bind(client) as (...args: unknown[]) => unknown;
      // biome-ignore lint/suspicious/noExplicitAny: подмена перегруженного метода драйвера
      (client as any).query = (...args: unknown[]): unknown =>
        args[0] === APP_SETTINGS_RESET_SQL ? original('SELECT 1/0') : original(...args);
    });
    const { events, observer } = recorder();
    const failure = await transactionKeepingFailure(
      drizzle(pool),
      async (tx) => {
        await tx.execute(sql`INSERT INTO edge VALUES ('reset.x')`);
      },
      { resetAppSettings: ['lib.marker'], observer },
    ).catch((error: unknown) => error);
    expect((failure as { code?: unknown }).code).toBe('22012');
    expect(events).toEqual(['acquired', `failed 1 ${TRANSACTION_STAGE.work} false`]);
    expect([pool.totalCount, pool.idleCount, await names(pool)]).toEqual([1, 1, []]);
  });

  it("sessionBaseline: 'defaults' сохраняет роль из ALTER ROLE … SET role: уборка возвращает её, а не вошедшего пользователя", async () => {
    const url = new URL(database.url);
    url.username = login;
    url.password = 'p';
    const pool = newPool([], url.toString());
    const currentUser = async (): Promise<string> =>
      transactionKeepingFailure(drizzle(pool), async (_tx, client) => {
        return (await client.query<{ u: string }>('SELECT current_user::text AS u')).rows[0]?.u as string;
      });
    // Контроль: свежая сессия — под ролью из ALTER ROLE, не под вошедшим.
    expect(await currentUser()).toBe(group);
    await transactionKeepingFailure(
      drizzle(pool),
      async (_tx, client) => {
        await client.query("SELECT set_config('role', 'none', false)");
        expect((await client.query<{ u: string }>('SELECT current_user::text AS u')).rows[0]?.u).toBe(login);
      },
      { resetSession: true, sessionBaseline: SESSION_BASELINE.defaults },
    );
    expect([await currentUser(), pool.totalCount]).toEqual([group, 1]);
  });

  it('снимок сессии: role и session_authorization не видны в pg_settings — восстанавливаются только явным блоком ролей', async () => {
    const pool = newPool();
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${group}`);
      const { rows } = await client.query<{ setting: string[]; role: string[] }>(SESSION_PROBE_SQL);
      expect(rows[0]?.setting.filter((item) => /^(role|session_authorization) = /.test(item))).toEqual([]);
      expect(rows[0]?.role).toContain(`current_user = ${group}`);
      await client.query('RESET ROLE');
    } finally {
      client.release();
    }
  });

  it('сервер: set_config с именованным is_local отвергает (42883), имена параметров без регистра, имя из трёх частей допустимо', async () => {
    const pool = newPool();
    const named = await pool
      .query("SELECT set_config('a.b', '1', is_local => true)")
      .catch((error: unknown) => error);
    expect((named as { code?: unknown }).code).toBe('42883');
    const seen = await transactionKeepingFailure(drizzle(pool), async (tx, client) => {
      await withTenant(tx, 't-7', 'app.context.tenant_id');
      await client.query("SELECT set_config('app.X', '1', true), set_config('app.x', '2', true)");
      return (
        await client.query<{ tenant: string; upper: string }>(
          "SELECT current_setting('app.context.tenant_id') AS tenant, current_setting('APP.X') AS upper",
        )
      ).rows[0];
    });
    expect(seen).toEqual({ tenant: 't-7', upper: '2' });
  });

  it('idle_session_timeout (57P05) приходит с severity FATAL — распознаётся как обрыв без отдельного кода в списке', async () => {
    const client = new Client({ connectionString: database.url });
    const errors: unknown[] = [];
    client.on('error', (error) => errors.push(error));
    await client.connect();
    await client.query('SET idle_session_timeout = 200');
    for (let i = 0; i < 50 && errors.length === 0; i += 1) {
      await pause(100);
    }
    await client.end().catch(() => undefined);
    // Первый — ответ сервера; следом pg сообщает о закрытом сокете.
    expect(errors.length).toBeGreaterThan(0);
    expect([(errors[0] as { code?: unknown }).code, (errors[0] as { severity?: unknown }).severity]).toEqual([
      '57P05',
      'FATAL',
    ]);
    expect(isConnectionFailure(errors[0])).toBe(true);
  });
});
