import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';

import { AdvisoryLockTimeoutError } from './advisory-lock-timeout.error';
import { createTestDatabase } from './testing/test-database';
import { withinSeconds } from './testing/within-seconds';
import { withAdvisoryLock } from './with-advisory-lock';
import { withSessionAdvisoryLock } from './with-session-advisory-lock';

const adminUrl = process.env.PG_TEST_URL;
const describeDb = adminUrl ? describe : describe.skip;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Держатель лока — отдельная сессия, как у второго экземпляра сервиса. */
describeDb('withAdvisoryLock / withSessionAdvisoryLock [нужен PG_TEST_URL]', () => {
  let database: { url: string; drop(): Promise<void> };
  let pool: Pool;
  let holder: Client;

  beforeAll(async () => {
    database = await createTestDatabase(adminUrl as string, ['CREATE TABLE al (name text PRIMARY KEY)']);
    pool = new Pool({ connectionString: database.url, max: 4 });
    holder = new Client({ connectionString: database.url });
    await holder.connect();
  });
  afterAll(async () => {
    await holder?.end();
    await pool?.end();
    await database?.drop();
  });

  /** Advisory-локи базы по всем сессиям: снятый лок не должен остаться ни у кого. */
  const advisoryLocks = async (): Promise<number> =>
    (
      await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
      )
    ).rows[0]?.n ?? -1;

  it.each([
    ['withAdvisoryLock', 'xact'],
    ['withSessionAdvisoryLock', 'session'],
  ])(
    '%s: лок занят дольше потолка — AdvisoryLockTimeoutError, работа не запускалась',
    async (_name, scope) => {
      await holder.query("SELECT pg_advisory_lock(hashtextextended('job:busy', 0))");
      let ran = false;
      try {
        const work = async (): Promise<void> => {
          ran = true;
        };
        const outcome =
          scope === 'xact'
            ? withAdvisoryLock(drizzle(pool), 'job:busy', work, { timeoutMs: 300 })
            : withSessionAdvisoryLock(drizzle(pool), 'job:busy', work, { timeoutMs: 300 });
        const failure = await withinSeconds(5, outcome).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AdvisoryLockTimeoutError);
        expect(ran).toBe(false);
      } finally {
        await holder.query("SELECT pg_advisory_unlock(hashtextextended('job:busy', 0))");
      }
      expect(await advisoryLocks()).toBe(0);
      expect(pool.totalCount - pool.idleCount).toBe(0);
    },
  );

  it.each([
    ['withAdvisoryLock', 'xact'],
    ['withSessionAdvisoryLock', 'session'],
  ])('%s: параллельные вызовы с одним ключом не пересекаются, лок снят после', async (_name, scope) => {
    let inside = 0;
    let peak = 0;
    const work = async (): Promise<void> => {
      inside += 1;
      peak = Math.max(peak, inside);
      await pause(30);
      inside -= 1;
    };
    await withinSeconds(
      10,
      Promise.all(
        Array.from({ length: 4 }, () =>
          scope === 'xact'
            ? withAdvisoryLock(drizzle(pool), 42, work, { timeoutMs: 5_000, pollMs: 5 })
            : withSessionAdvisoryLock(drizzle(pool), 42, work, { timeoutMs: 5_000, pollMs: 5 }),
        ),
      ),
    );
    expect(peak).toBe(1);
    expect(await advisoryLocks()).toBe(0);
  });

  it('xact: работа идёт в транзакции лока — отказ работы откатывает запись и снимает лок', async () => {
    await expect(
      withAdvisoryLock(
        drizzle(pool),
        7n,
        async (tx) => {
          await tx.execute(sql`INSERT INTO al VALUES ('xact.rolled')`);
          throw new Error('отказ под локом');
        },
        { timeoutMs: 1_000 },
      ),
    ).rejects.toThrow('отказ под локом');
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM al WHERE name = 'xact.rolled'")).rows[0]?.n,
    ).toBe(0);
    expect(await advisoryLocks()).toBe(0);
  });

  it('session: работа сама сняла лок — соединение не возвращается в пул с чужим состоянием, а уничтожается', async () => {
    // Пул сообщает об удалении после закрытия соединения — асинхронно.
    const removed = new Promise<unknown>((resolve) => pool.once('remove', resolve));
    let used: unknown;
    await withSessionAdvisoryLock(
      drizzle(pool),
      'job:self-unlock',
      async (client) => {
        // Работа получает защищённое соединение (обёртку): то же соединение — по pid сервера.
        used = (client as unknown as { processID: number }).processID;
        await client.query("SELECT pg_advisory_unlock(hashtextextended('job:self-unlock', 0))");
      },
      { timeoutMs: 1_000 },
    );
    expect(used).toBeDefined();
    expect(((await withinSeconds(5, removed)) as { processID?: number }).processID).toBe(used);
    expect(await advisoryLocks()).toBe(0);
  });

  it('отмена в ожидании лока — отказ причиной отмены, работа не запускалась', async () => {
    await holder.query('SELECT pg_advisory_lock(99)');
    const controller = new AbortController();
    const reason = new Error('SIGTERM');
    let ran = false;
    try {
      setTimeout(() => controller.abort(reason), 100);
      const outcome = withSessionAdvisoryLock(
        drizzle(pool),
        99,
        async () => {
          ran = true;
        },
        { timeoutMs: 60_000, signal: controller.signal },
      );
      await expect(withinSeconds(5, outcome)).rejects.toBe(reason);
      expect(ran).toBe(false);
    } finally {
      await holder.query('SELECT pg_advisory_unlock(99)');
    }
  });

  it('ключ и потолок проверяются до соединения', async () => {
    const work = async (): Promise<void> => undefined;
    await expect(withAdvisoryLock(drizzle(pool), '', work, { timeoutMs: 100 })).rejects.toThrow('пуст');
    await expect(withAdvisoryLock(drizzle(pool), 1.5, work, { timeoutMs: 100 })).rejects.toThrow(
      'безопасное целое',
    );
    await expect(withAdvisoryLock(drizzle(pool), 2n ** 63n, work, { timeoutMs: 100 })).rejects.toThrow(
      'вне int8',
    );
    await expect(
      withAdvisoryLock(drizzle(pool), 1, work, { timeoutMs: undefined as unknown as number }),
    ).rejects.toThrow('timeoutMs обязателен');
    await expect(withSessionAdvisoryLock(drizzle(pool), 1, work, { timeoutMs: 0 })).rejects.toThrow(
      'timeoutMs — целое больше нуля',
    );
  });
});
