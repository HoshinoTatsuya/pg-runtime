import { sql } from 'drizzle-orm';

import { runInvoicing } from '../examples/advisory-locks';
import { createDb, orders, placeOrder } from '../examples/quick-start';
import { createTestDatabase } from './testing/test-database';

const adminUrl = process.env.PG_TEST_URL;
const describeDb = adminUrl ? describe : describe.skip;

/** Примеры README исполняются на настоящем Postgres: «компилируется» ещё не значит «работает». */
describeDb('примеры README на настоящей базе [нужен PG_TEST_URL]', () => {
  let database: { url: string; drop(): Promise<void> };
  let handle: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await createTestDatabase(adminUrl as string, [
      'CREATE TABLE orders (id serial PRIMARY KEY, customer text NOT NULL, total integer NOT NULL)',
      "CREATE TABLE invoices (customer_id integer NOT NULL, state text NOT NULL DEFAULT 'draft')",
      'INSERT INTO invoices (customer_id) VALUES (7), (7), (8)',
    ]);
    handle = createDb(database.url);
  });
  afterAll(async () => {
    await handle?.pool.end();
    await database?.drop();
  });

  it('quick-start: заказ записан, id возвращён, соединение вернулось в пул', async () => {
    const id = await placeOrder(handle.db, 'alice', 120);
    const rows = await handle.db.select().from(orders);
    expect(rows).toEqual([{ id, customer: 'alice', total: 120 }]);
    expect({ total: handle.pool.totalCount, idle: handle.pool.idleCount }).toEqual({ total: 1, idle: 1 });
  });

  it('advisory-locks: работа под локом выполнена ровно для своего клиента', async () => {
    await expect(runInvoicing(handle.db, 7)).resolves.toBe('done');
    const { rows } = await handle.db.execute<{ customer_id: number; state: string }>(
      sql`SELECT customer_id, state FROM invoices ORDER BY customer_id, state`,
    );
    expect(rows).toEqual([
      { customer_id: 7, state: 'issued' },
      { customer_id: 7, state: 'issued' },
      { customer_id: 8, state: 'draft' },
    ]);
  });
});
