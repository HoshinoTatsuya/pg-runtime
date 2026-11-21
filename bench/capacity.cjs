'use strict';
/**
 * Замер накладных расходов транзакции. Запуск:
 * `pnpm build && scripts/with-postgres.sh node bench/capacity.cjs`.
 *
 * Сравнивается с `db.transaction` drizzle на одной и той же работе (один
 * INSERT): что стоит библиотека сверх него, при какой параллельности, и во
 * что обходятся таймауты транзакции.
 */
const { performance } = require('node:perf_hooks');
const { drizzle } = require('drizzle-orm/node-postgres');
const { sql } = require('drizzle-orm');
const { Pool } = require('pg');
const { transactionKeepingFailure } = require('../dist/index.js');

const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

async function measure(concurrency, total, body) {
  const latencies = [];
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < total) {
        next++;
        const t0 = performance.now();
        await body();
        latencies.push(performance.now() - t0);
      }
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  return `${Math.round(total / seconds)}/с, p50 ${pct(latencies, 50).toFixed(2)} мс, p99 ${pct(latencies, 99).toFixed(2)} мс`;
}

async function main() {
  const url = process.env.PG_TEST_URL;
  if (!url) {
    throw new Error('PG_TEST_URL не задан: запуск через scripts/with-postgres.sh');
  }
  const pool = new Pool({ connectionString: url, max: 10 });
  const db = drizzle(pool);
  // Пул, которому приложение задаёт параметры на connect: на нём уборка сессии
  // (`resetSession`) к значениям по умолчанию и к состоянию после connect.
  const connectPool = new Pool({ connectionString: url, max: 10 });
  connectPool.on('connect', (client) => {
    client.query("SET search_path TO public; SET TIME ZONE 'UTC'; SET application_name = 'bench'").catch(() => undefined);
  });
  const connectDb = drizzle(connectPool);
  await pool.query('DROP TABLE IF EXISTS bench_rows; CREATE TABLE bench_rows (id bigserial PRIMARY KEY, v int)');
  const work = async (tx) => {
    await tx.execute(sql`INSERT INTO bench_rows (v) VALUES (1)`);
  };
  const variants = [
    ['db.transaction drizzle (база)', () => db.transaction(work)],
    ['transactionKeepingFailure', () => transactionKeepingFailure(db, work)],
    [
      'transactionKeepingFailure + 3 таймаута',
      () =>
        transactionKeepingFailure(db, work, {
          lockTimeoutMs: 2_000,
          statementTimeoutMs: 30_000,
          idleInTransactionTimeoutMs: 60_000,
        }),
    ],
    // Под пулером: фильтр текста и сверка состояния серверного соединения
    // (снимок тем же сообщением, что BEGIN и COMMIT, — без лишних обращений).
    ['transactionKeepingFailure + transactionPooler', () => transactionKeepingFailure(db, work, { transactionPooler: true })],
    [
      'transactionKeepingFailure + transactionPooler без сверки',
      () => transactionKeepingFailure(db, work, { transactionPooler: true, sessionStateCheck: false }),
    ],
    // Уборка сессии: к значениям по умолчанию (`RESET ALL` и остальное одним
    // запросом) и к состоянию после connect (то же + восстановление снимка,
    // снимок — один раз на соединение тем же сообщением, что BEGIN).
    ['resetSession, пул с connect: defaults', () => transactionKeepingFailure(connectDb, work, { resetSession: true, sessionBaseline: 'defaults' })],
    ['resetSession, пул с connect: connect', () => transactionKeepingFailure(connectDb, work, { resetSession: true })],
  ];
  for (const concurrency of [1, 10, 50]) {
    console.log(`## параллельно ${concurrency}, пул 10`);
    for (const [label, body] of variants) {
      await measure(concurrency, 500, body);
      console.log(`${label}: ${await measure(concurrency, 3_000, body)}`);
    }
  }
  await pool.end();
  await connectPool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
