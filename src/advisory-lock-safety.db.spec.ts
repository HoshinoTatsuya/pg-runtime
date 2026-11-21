import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';

import { AdvisoryLockLostError } from './advisory-lock-lost.error';
import { AdvisoryLockTimeoutError } from './advisory-lock-timeout.error';
import { CLIENT_MISUSE } from './constants/client-misuse.constant';
import { RETRY_REASON } from './constants/retry-reason.constant';
import { NestedTransactionError } from './nested-transaction.error';
import { startFreezingProxy } from './testing/freezing-proxy';
import { createTestDatabase } from './testing/test-database';
import { withinSeconds } from './testing/within-seconds';
import { TransactionClientMisuseError } from './transaction-client-misuse.error';
import { TransactionConnectionLostError } from './transaction-connection-lost.error';
import { transactionKeepingFailure } from './transaction-keeping-failure';
import { TransactionLeftOpenError } from './transaction-left-open.error';
import { withAdvisoryLock } from './with-advisory-lock';
import { withSessionAdvisoryLock } from './with-session-advisory-lock';

const adminUrl = process.env.PG_TEST_URL;
const describeDb = adminUrl ? describe : describe.skip;

// Потолок запроса опроса и снятия лока — 5 с (`ROLLBACK_TIMEOUT_MS`): сценарии
// замёрзшей сети ждут его, остальное — доли секунды.
jest.setTimeout(30_000);

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Advisory-локи на отказах соединения и при неверном обращении работы с ним:
 * замёрзшая сеть (прокси пакета), release/end из работы, вызов внутри
 * транзакции того же пула, повтор по истёкшему потолку лока.
 */
describeDb('advisory-локи: отказы и защита соединения [нужен PG_TEST_URL]', () => {
  let database: { url: string; drop(): Promise<void> };
  let holder: Client;

  beforeAll(async () => {
    database = await createTestDatabase(adminUrl as string, ['CREATE TABLE lock_work (tag text)']);
    holder = new Client({ connectionString: database.url });
    await holder.connect();
  });
  afterAll(async () => {
    await holder?.end();
    await database?.drop();
  });

  /** Advisory-локи этой базы по всем сессиям. */
  const advisoryLocks = async (): Promise<number> =>
    (
      await holder.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
      )
    ).rows[0]?.n ?? -1;

  /** Пул через замёрзающий прокси с одним уже открытым соединением. */
  const frozenPool = async (): Promise<{ pool: Pool; freeze(): void; close(): Promise<void> }> => {
    const target = new URL(database.url);
    const proxy = await startFreezingProxy({ host: target.hostname, port: Number(target.port) });
    const viaProxy = new URL(database.url);
    viaProxy.port = String(proxy.port);
    const pool = new Pool({ connectionString: viaProxy.toString(), max: 1 });
    pool.on('error', () => undefined);
    await pool.query('SELECT 1');
    return {
      pool,
      freeze: () => proxy.freeze(),
      close: async () => {
        await withinSeconds(5, pool.end()).catch(() => undefined);
        await proxy.close();
      },
    };
  };

  /** Лок снимает сервер вместе с сессией, а сессия кончается не мгновенно. */
  const locksDrained = async (): Promise<number> => {
    for (let i = 0; i < 50 && (await advisoryLocks()) !== 0; i += 1) {
      await pause(100);
    }
    return advisoryLocks();
  };

  it.each([
    ['withSessionAdvisoryLock', 'session'],
    ['withAdvisoryLock', 'xact'],
  ])(
    '%s: сеть замёрзла посреди опроса занятого лока — отказ по потолку запроса, а не вечное ожидание; соединение уничтожено',
    async (_name, scope) => {
      await holder.query("SELECT pg_advisory_lock(hashtextextended('frozen:acquire', 0))");
      const frozen = await frozenPool();
      try {
        let ran = false;
        const work = async (): Promise<void> => {
          ran = true;
        };
        const outcome =
          scope === 'session'
            ? withSessionAdvisoryLock(drizzle(frozen.pool), 'frozen:acquire', work, {
                timeoutMs: 1_000,
                pollMs: 50,
              })
            : withAdvisoryLock(drizzle(frozen.pool), 'frozen:acquire', work, {
                timeoutMs: 1_000,
                pollMs: 50,
                rollbackTimeoutMs: 200,
              });
        // Опрос идёт (лок занят), и следующий его запрос уходит в замёрзшую сеть.
        await pause(300);
        frozen.freeze();
        const failure = await withinSeconds(12, outcome).catch((error: unknown) => error);
        expect((failure as Error).message).not.toContain('не завершилось');
        expect([ran, frozen.pool.totalCount]).toEqual([false, 0]);
      } finally {
        await frozen.close();
        await holder.query("SELECT pg_advisory_unlock(hashtextextended('frozen:acquire', 0))");
      }
      expect(await locksDrained()).toBe(0);
    },
  );

  it('withSessionAdvisoryLock: сеть замёрзла после работы — снятие лока по потолку, результат работы наружу, соединение уничтожено', async () => {
    const frozen = await frozenPool();
    try {
      const outcome = withSessionAdvisoryLock(
        drizzle(frozen.pool),
        'frozen:unlock',
        async () => {
          frozen.freeze();
          return 'сделано';
        },
        { timeoutMs: 1_000 },
      );
      await expect(withinSeconds(12, outcome)).resolves.toBe('сделано');
      expect(frozen.pool.totalCount).toBe(0);
    } finally {
      await frozen.close();
    }
    expect(await locksDrained()).toBe(0);
  });

  it.each([
    ['release', CLIENT_MISUSE.release],
    ['end', CLIENT_MISUSE.end],
  ] as const)(
    'withSessionAdvisoryLock: client.%s() из работы — TransactionClientMisuseError, лок снят, соединение исправно в пуле',
    async (method, misuse) => {
      const pool = new Pool({ connectionString: database.url, max: 1 });
      try {
        const failure = await withinSeconds(
          5,
          withSessionAdvisoryLock(
            drizzle(pool),
            'misuse',
            async (client) => {
              (client[method] as () => unknown)();
            },
            { timeoutMs: 1_000 },
          ),
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(TransactionClientMisuseError);
        expect((failure as TransactionClientMisuseError).misuse).toBe(misuse);
        expect([pool.totalCount, pool.idleCount]).toEqual([1, 1]);
        expect(await advisoryLocks()).toBe(0);
        expect((await pool.query<{ n: number }>('SELECT 1 AS n')).rows[0]?.n).toBe(1);
      } finally {
        await pool.end();
      }
    },
  );

  it('withSessionAdvisoryLock внутри работы транзакции того же пула — NestedTransactionError до пула, а не вечное ожидание второго соединения', async () => {
    const pool = new Pool({ connectionString: database.url, max: 1 });
    try {
      const failure = await withinSeconds(
        5,
        transactionKeepingFailure(drizzle(pool), () =>
          withSessionAdvisoryLock(drizzle(pool), 'nested', async () => 'x', { timeoutMs: 1_000 }),
        ),
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(NestedTransactionError);
      expect((failure as Error).message).toContain('withSessionAdvisoryLock внутри работы транзакции');
      expect([pool.totalCount, pool.idleCount]).toEqual([1, 1]);
    } finally {
      await pool.end();
    }
    // Двойник: транзакция внутри работы сессионного лока (свой процесс со своими
    // транзакциями) — законна; другой пул внутри транзакции — тоже.
    const two = new Pool({ connectionString: database.url, max: 2 });
    const other = new Pool({ connectionString: database.url, max: 1 });
    try {
      expect(
        await withinSeconds(
          5,
          withSessionAdvisoryLock(
            drizzle(two),
            'outer',
            () => transactionKeepingFailure(drizzle(two), async () => 'inner'),
            { timeoutMs: 1_000 },
          ),
        ),
      ).toBe('inner');
      expect(
        await withinSeconds(
          5,
          transactionKeepingFailure(drizzle(two), () =>
            withSessionAdvisoryLock(drizzle(other), 'other-pool', async () => 'ok', { timeoutMs: 1_000 }),
          ),
        ),
      ).toBe('ok');
    } finally {
      await two.end();
      await other.end();
    }
  });

  it("withAdvisoryLock с retry.on ['lock-timeout']: лок освободился между попытками — повтор берёт его, работа выполнена", async () => {
    const pool = new Pool({ connectionString: database.url, max: 2 });
    await holder.query("SELECT pg_advisory_lock(hashtextextended('retry:me', 0))");
    const failures: Array<[number, boolean, string]> = [];
    let released = false;
    try {
      const outcome = withAdvisoryLock(drizzle(pool), 'retry:me', async () => 'взят', {
        timeoutMs: 150,
        retry: { attempts: 6, on: [RETRY_REASON.lockTimeout], backoffMs: 50 },
        observer: {
          attemptFailed: ({ attempt, willRetry, error }) => {
            failures.push([attempt, willRetry, (error as Error).name]);
          },
        },
      });
      await pause(250);
      await holder.query("SELECT pg_advisory_unlock(hashtextextended('retry:me', 0))");
      released = true;
      await expect(withinSeconds(10, outcome)).resolves.toBe('взят');
      expect(failures.length).toBeGreaterThan(0);
      expect(failures.every(([, willRetry, name]) => willRetry && name === 'AdvisoryLockTimeoutError')).toBe(
        true,
      );
    } finally {
      if (!released) {
        await holder.query("SELECT pg_advisory_unlock(hashtextextended('retry:me', 0))");
      }
      await pool.end();
    }
    // Двойник: без lock-timeout в retry.on — отказ с первой попытки.
    await holder.query("SELECT pg_advisory_lock(hashtextextended('retry:no', 0))");
    const plain = new Pool({ connectionString: database.url, max: 1 });
    try {
      const attempts: number[] = [];
      const failure = await withAdvisoryLock(drizzle(plain), 'retry:no', async () => 'x', {
        timeoutMs: 100,
        retry: { attempts: 3, backoffMs: 10 },
        observer: { attemptFailed: ({ attempt }) => attempts.push(attempt) },
      }).catch((error: unknown) => error);
      expect([failure instanceof AdvisoryLockTimeoutError, attempts]).toEqual([true, [1]]);
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtextextended('retry:no', 0))");
      await plain.end();
    }
  });

  it('withSessionAdvisoryLock: отмена посреди запроса опроса с причиной без прототипа — отказ этой причиной, соединение уничтожено (сборка текста причины не срывает уборку)', async () => {
    await holder.query("SELECT pg_advisory_lock(hashtextextended('abort:bare', 0))");
    const frozen = await frozenPool();
    try {
      const controller = new AbortController();
      const reason = Object.create(null) as object;
      const outcome = withSessionAdvisoryLock(drizzle(frozen.pool), 'abort:bare', async () => 'x', {
        timeoutMs: 10_000,
        pollMs: 50,
        signal: controller.signal,
      });
      await pause(300);
      frozen.freeze();
      // Следующий запрос опроса ушёл в замёрзшую сеть — отмена приходит посреди него.
      await pause(300);
      controller.abort(reason);
      const failure = await withinSeconds(5, outcome).catch((error: unknown) => error);
      expect(failure).toBe(reason);
      expect(frozen.pool.totalCount).toBe(0);
    } finally {
      await frozen.close();
      await holder.query("SELECT pg_advisory_unlock(hashtextextended('abort:bare', 0))");
    }
  });

  /** Строки работы с меткой: зафиксированы ли они. */
  const committedTags = async (tag: string): Promise<number> =>
    (await holder.query<{ n: number }>('SELECT count(*)::int AS n FROM lock_work WHERE tag = $1', [tag]))
      .rows[0]?.n ?? -1;

  /**
   * Следующий владелец соединения пула в СВОЕЙ транзакции: простой протокол
   * (без параметров), где `now()` неявной транзакции равно началу оператора.
   */
  const ownTransaction = async (pool: Pool): Promise<boolean | undefined> =>
    (await pool.query<{ own: boolean }>('SELECT now() = statement_timestamp() AS own')).rows[0]?.own;

  it.each([
    [
      'BEGIN и return',
      async (client: { query(text: string): Promise<unknown> }) => {
        await client.query('BEGIN');
        await client.query("INSERT INTO lock_work VALUES ('left:return')");
        return 'вернулась';
      },
      'left:return',
      false,
    ],
    [
      'BEGIN и throw обычной ошибки JS',
      async (client: { query(text: string): Promise<unknown> }) => {
        await client.query('BEGIN');
        await client.query("INSERT INTO lock_work VALUES ('left:throw')");
        throw new Error('сбой работы после BEGIN');
      },
      'left:throw',
      true,
    ],
    [
      'BEGIN, отказ запроса пойман, return',
      async (client: { query(text: string): Promise<unknown> }) => {
        await client.query('BEGIN');
        await client.query("INSERT INTO lock_work VALUES ('left:failed')");
        await client.query('SELECT 1/0').catch(() => undefined);
        return 'вернулась';
      },
      'left:failed',
      false,
    ],
  ])(
    'withSessionAdvisoryLock: %s — отказ TransactionLeftOpenError, ничего не зафиксировано, следующий владелец соединения в своей транзакции',
    async (_name, work, tag, threw) => {
      const pool = new Pool({ connectionString: database.url, max: 1 });
      try {
        const failure = await withinSeconds(
          10,
          withSessionAdvisoryLock(drizzle(pool), `left-open:${tag}`, work, { timeoutMs: 1_000 }),
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(TransactionLeftOpenError);
        expect(((failure as Error).cause as Error | undefined)?.message).toBe(
          threw ? 'сбой работы после BEGIN' : undefined,
        );
        expect(pool.totalCount).toBe(0);
        expect(await ownTransaction(pool)).toBe(true);
        expect(await committedTags(tag)).toBe(0);
      } finally {
        await pool.end();
      }
      expect(await locksDrained()).toBe(0);
    },
  );

  it('withSessionAdvisoryLock: работа со своими BEGIN … COMMIT — результат наружу, соединение исправно в пуле (проверка открытой транзакции не даёт ложных отказов)', async () => {
    const pool = new Pool({ connectionString: database.url, max: 1 });
    try {
      for (let round = 0; round < 50; round += 1) {
        const result = await withinSeconds(
          5,
          withSessionAdvisoryLock(
            pool,
            'closed-own',
            async (client) => {
              await client.query('BEGIN');
              await client.query("INSERT INTO lock_work VALUES ('closed:own')");
              await client.query('COMMIT');
              return round;
            },
            { timeoutMs: 1_000 },
          ),
        );
        expect(result).toBe(round);
      }
      expect([pool.totalCount, pool.idleCount]).toEqual([1, 1]);
      expect(await committedTags('closed:own')).toBe(50);
      expect(await advisoryLocks()).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it.each([
    ['вернулась', false],
    ['бросила', true],
  ])(
    'withSessionAdvisoryLock: сессию разорвали во время работы, работа %s — AdvisoryLockLostError (стадия work), а не тихий успех',
    async (_name, throws) => {
      const pool = new Pool({ connectionString: database.url, max: 1 });
      pool.on('error', () => undefined);
      const workError = new Error('отказ работы после разрыва');
      try {
        const failure = await withinSeconds(
          10,
          withSessionAdvisoryLock(
            drizzle(pool),
            `lost:${String(throws)}`,
            async (client) => {
              const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
                ?.pid;
              await holder.query('SELECT pg_terminate_backend($1)', [pid]);
              // 300 мс: событие 'error' разрыва успевает прийти ДО возврата работы.
              await pause(300);
              if (throws) {
                throw workError;
              }
              return 'ok';
            },
            { timeoutMs: 1_000 },
          ),
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AdvisoryLockLostError);
        expect(failure).toBeInstanceOf(TransactionConnectionLostError);
        expect((failure as AdvisoryLockLostError).stage).toBe('work');
        expect((failure as AdvisoryLockLostError).workError).toBe(throws ? workError : undefined);
        expect(pool.totalCount).toBe(0);
      } finally {
        await pool.end();
      }
    },
  );

  it('withSessionAdvisoryLock принимает сам пул pg, не только drizzle над ним', async () => {
    const pool = new Pool({ connectionString: database.url, max: 1 });
    try {
      const pid = await withSessionAdvisoryLock(
        pool,
        'plain-pool',
        async (client) =>
          (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid,
        { timeoutMs: 1_000 },
      );
      expect(typeof pid).toBe('number');
      expect(await advisoryLocks()).toBe(0);
    } finally {
      await pool.end();
    }
  });
});
