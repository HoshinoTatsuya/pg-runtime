import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';

import { createTestDatabase } from './testing/test-database';
import { transactionKeepingFailure } from './transaction-keeping-failure';
import { withTenant } from './with-tenant';

const adminUrl = process.env.PG_TEST_URL;
const describeDb = adminUrl ? describe : describe.skip;

/**
 * Контекст RLS — под ролью ПРИЛОЖЕНИЯ, без суперправ: суперпользователь обходит
 * политики, и проверка изоляции под ним зелёная при любой реализации. Пул max=1:
 * следующая транзакция идёт по тому же соединению и увидела бы контекст,
 * оставшийся от предыдущей, — ровно дефект «сессионный SET уезжает соседу».
 */
describeDb('withTenant и localSettings под RLS [нужен PG_TEST_URL]', () => {
  const role = `app_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let database: { url: string; drop(): Promise<void> };
  let pool: Pool;

  beforeAll(async () => {
    database = await createTestDatabase(adminUrl as string, [
      'CREATE TABLE notes (tenant text NOT NULL, body text NOT NULL)',
      "INSERT INTO notes VALUES ('a', 'a.1'), ('a', 'a.2'), ('b', 'b.1')",
      'ALTER TABLE notes ENABLE ROW LEVEL SECURITY',
      "CREATE POLICY own ON notes USING (tenant = current_setting('app.tenant_id', true))",
      `CREATE ROLE ${role} LOGIN PASSWORD 'app' NOSUPERUSER NOBYPASSRLS`,
      `GRANT SELECT, INSERT ON notes TO ${role}`,
    ]);
    const url = new URL(database.url);
    url.username = role;
    url.password = 'app';
    pool = new Pool({ connectionString: url.toString(), max: 1 });
  });
  afterAll(async () => {
    await pool?.end();
    await database?.drop();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  const visible = (tenant?: string) =>
    transactionKeepingFailure(drizzle(pool), async (tx) => {
      if (tenant !== undefined) {
        await withTenant(tx, tenant);
      }
      const result = await tx.execute<{ body: string }>(sql`SELECT body FROM notes ORDER BY body`);
      return result.rows.map((row) => row.body);
    });

  it('роль приложения не обходит RLS (иначе проверка ниже ничего не доказывает)', async () => {
    const { rows } = await pool.query<{ superuser: boolean; bypass: boolean }>(
      'SELECT rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user',
    );
    expect(rows).toEqual([{ superuser: false, bypass: false }]);
  });

  it('арендатор видит только свои строки, и контекст не переживает транзакцию', async () => {
    expect(await visible('a')).toEqual(['a.1', 'a.2']);
    // Та же сессия (пул max=1), контекста нет — ничего не видно, а не строки «a».
    expect(await visible()).toEqual([]);
    expect(await visible('b')).toEqual(['b.1']);
    expect(await visible()).toEqual([]);
  });

  it('localSettings — тот же контекст без отдельного запроса', async () => {
    const queries: string[] = [];
    pool.once('acquire', (client) => {
      const original = client.query.bind(client) as (...args: unknown[]) => unknown;
      const spy = (...args: unknown[]): unknown => {
        const first = args[0] as string | { text?: string };
        queries.push(typeof first === 'string' ? first : (first.text ?? ''));
        return original(...args);
      };
      // biome-ignore lint/suspicious/noExplicitAny: подмена перегруженного метода драйвера на одну транзакцию
      (client as any).query = spy;
      pool.once('release', () => {
        // biome-ignore lint/suspicious/noExplicitAny: возврат метода прототипа
        delete (client as any).query;
      });
    });
    const rows = await transactionKeepingFailure(
      drizzle(pool),
      async (tx) => (await tx.execute<{ body: string }>(sql`SELECT body FROM notes ORDER BY body`)).rows,
      { localSettings: { 'app.tenant_id': 'a' }, lockTimeoutMs: 1_000 },
    );
    expect(rows.map((row) => row.body)).toEqual(['a.1', 'a.2']);
    // BEGIN, один set_config на всё, запрос работы, COMMIT.
    expect(queries.filter((text) => text.includes('set_config'))).toHaveLength(1);
    expect(queries).toHaveLength(4);
    expect(await visible()).toEqual([]);
  });

  it('пустой арендатор и параметр без префикса — отказ до запроса', async () => {
    await expect(visible('')).rejects.toThrow('идентификатор арендатора пуст');
    await expect(visible('  ')).rejects.toThrow('идентификатор арендатора пуст');
    await expect(
      transactionKeepingFailure(drizzle(pool), async (tx) => withTenant(tx, 'a', 'tenant_id')),
    ).rejects.toThrow('вида префикс.имя');
  });

  it('localSettings с недопустимым именем или повтором таймаута — отказ до соединения', async () => {
    await expect(
      transactionKeepingFailure(drizzle(pool), async () => 'x', { localSettings: { 'a b': '1' } }),
    ).rejects.toThrow('недопустимое имя параметра «a b»');
    await expect(
      transactionKeepingFailure(drizzle(pool), async () => 'x', {
        lockTimeoutMs: 100,
        localSettings: { lock_timeout: '5s' },
      }),
    ).rejects.toThrow('localSettings.lock_timeout задан и опцией таймаута');
  });
});
