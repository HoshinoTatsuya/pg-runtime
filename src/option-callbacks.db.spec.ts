import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { NESTED_TRANSACTION } from './constants/nested-transaction.constant';
import { createTestDatabase } from './testing/test-database';
import { withinSeconds } from './testing/within-seconds';
import { TransactionCallbackError } from './transaction-callback.error';
import { transactionKeepingFailure } from './transaction-keeping-failure';

const adminUrl = process.env.PG_TEST_URL;
const describeDb = adminUrl ? describe : describe.skip;

jest.setTimeout(30_000);

/**
 * Колбэки опций (`retry.when`, `wrapFailure`) бросили: наружу — отказ,
 * называющий колбэк, с исходным отказом попытки в `cause`, а не голая ошибка
 * колбэка без того, ЧТО упало; наблюдатель попытки вызван.
 */
describeDb('колбэки опций транзакции бросают [нужен PG_TEST_URL]', () => {
  let database: { url: string; drop(): Promise<void> };
  let pool: Pool;

  beforeAll(async () => {
    database = await createTestDatabase(adminUrl as string);
    pool = new Pool({ connectionString: database.url, max: 1 });
  });
  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  it('retry.when бросил — TransactionCallbackError (retry.when), отказ работы в cause, attemptFailed вызван, соединение исправно', async () => {
    const workError = new Error('отказ работы');
    const callbackError = new Error('when сломан');
    const failed: Array<[number, boolean, unknown]> = [];
    const failure = await withinSeconds(
      5,
      transactionKeepingFailure(
        drizzle(pool),
        async () => {
          throw workError;
        },
        {
          retry: {
            attempts: 3,
            on: [],
            when: () => {
              throw callbackError;
            },
          },
          observer: {
            attemptFailed: ({ attempt, willRetry, error }) => failed.push([attempt, willRetry, error]),
          },
        },
      ),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TransactionCallbackError);
    expect((failure as TransactionCallbackError).callback).toBe('retry.when');
    expect((failure as TransactionCallbackError).callbackError).toBe(callbackError);
    expect((failure as Error).cause).toBe(workError);
    expect(failed).toEqual([[1, false, workError]]);
    expect([pool.totalCount, pool.idleCount]).toEqual([1, 1]);
  });

  it.each([
    ['внешняя транзакция', false],
    ['точка сохранения', true],
  ])(
    'wrapFailure бросил (%s) — TransactionCallbackError (wrapFailure), отказ работы в cause',
    async (_name, nested) => {
      const workError = new Error('отказ работы');
      const callbackError = new Error('wrapFailure сломан');
      const wrapFailure = (): never => {
        throw callbackError;
      };
      const db = drizzle(pool);
      const run = (): Promise<unknown> =>
        nested
          ? transactionKeepingFailure(db, () =>
              transactionKeepingFailure(
                db,
                async () => {
                  throw workError;
                },
                { nested: NESTED_TRANSACTION.savepoint, wrapFailure },
              ).catch((error: unknown) => ({ inner: error })),
            )
          : transactionKeepingFailure(
              db,
              async () => {
                throw workError;
              },
              { wrapFailure },
            ).catch((error: unknown) => ({ inner: error }));
      const { inner } = (await withinSeconds(5, run())) as { inner: unknown };
      expect(inner).toBeInstanceOf(TransactionCallbackError);
      expect((inner as TransactionCallbackError).callback).toBe('wrapFailure');
      expect((inner as TransactionCallbackError).callbackError).toBe(callbackError);
      expect((inner as Error).cause).toBe(workError);
      expect([pool.totalCount, pool.idleCount]).toEqual([1, 1]);
    },
  );
});
