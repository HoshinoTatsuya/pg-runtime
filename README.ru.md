# @hoshinotatsuya/pg-runtime

[![npm](https://img.shields.io/npm/v/@hoshinotatsuya/pg-runtime.svg)](https://www.npmjs.com/package/@hoshinotatsuya/pg-runtime)
[![CI](https://github.com/HoshinoTatsuya/pg-runtime/actions/workflows/ci.yml/badge.svg)](https://github.com/HoshinoTatsuya/pg-runtime/actions/workflows/ci.yml)

[English version](README.md) · [Changelog](CHANGELOG.md)

Транзакции Postgres для [drizzle-orm](https://orm.drizzle.team) над [node-postgres](https://node-postgres.com),
после которых соединение пула не утекает, не отравлено и не врёт об исходе.

У `db.transaction` drizzle-orm 0.45.2 есть дефекты, которые видны только при отказе — то есть ровно тогда, когда
слой транзакций обязан быть правильным:

| `db.transaction` | `transactionKeepingFailure` |
|---|---|
| BEGIN выполняется до `try`: при его отказе соединение не возвращается в пул никогда (10 отказов подвешивают всё обращение к базе) | BEGIN внутри `try`, соединение возвращается всегда |
| отказ COMMIT на оборвавшемся соединении подменяется отказом ROLLBACK | наружу — исходный отказ |
| соединение с непрошедшим откатом возвращается в пул как исправное | `release(error)` — пул его уничтожает |
| COMMIT, на который сервер ответил ROLLBACK (работа перехватила отказ запроса), считается успехом при пустой базе | `CommitRolledBackError` |
| обрыв после отправки COMMIT — обычный отказ | `CommitOutcomeUnknownError`: «могло зафиксироваться», не повторяется |
| разрыв сессии сервером (`idle_in_transaction_session_timeout`, failover) роняет процесс необработанным `'error'` | `TransactionConnectionLostError` |
| вложенный вызов на том же пуле ждёт второе соединение: при `max` параллельных вызовах пул встаёт навсегда | `NestedTransactionError` или, по запросу, точка сохранения |

Сверх того: параметры и таймауты только на транзакцию, повтор на 40001/40P01, контекст арендатора для RLS,
advisory-локи с потолком ожидания и защита работы за PgBouncer в transaction mode. Всё проверено на настоящем
Postgres и настоящем PgBouncer.

## Установка

```sh
pnpm add @hoshinotatsuya/pg-runtime drizzle-orm pg
pnpm add -D @types/pg
```

Peer-зависимости: `drizzle-orm >=0.45.2 <0.46`, `pg ^8.18.0`, необязательно `@types/pg >=8.15.0`. Пакет —
CommonJS с раздельными декларациями для `import` (`.d.mts`) и `require` (`.d.ts`): работает из CommonJS и ESM
(`node16`, `nodenext`, `bundler`).

## Быстрый старт

<!-- код ниже — examples/quick-start.ts: проходит typecheck и исполняется на Postgres в наборе тестов -->
<!-- example: examples/quick-start.ts -->
```ts
import { CommitOutcomeUnknownError, transactionKeepingFailure } from '@hoshinotatsuya/pg-runtime';
import { drizzle } from 'drizzle-orm/node-postgres';
import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';

export const orders = pgTable('orders', {
  id: serial('id').primaryKey(),
  customer: text('customer').notNull(),
  total: integer('total').notNull(),
});

export function createDb(connectionString: string) {
  // query_timeout is the only ceiling on BEGIN/COMMIT on a frozen network: always set it.
  const pool = new Pool({ connectionString, max: 10, query_timeout: 10_000 });
  return { pool, db: drizzle(pool) };
}

type Db = ReturnType<typeof createDb>['db'];

export async function placeOrder(db: Db, customer: string, total: number): Promise<number> {
  try {
    return await transactionKeepingFailure(db, async (tx) => {
      const [row] = await tx.insert(orders).values({ customer, total }).returning({ id: orders.id });
      if (row === undefined) {
        throw new Error('INSERT … RETURNING returned no row');
      }
      return row.id;
    });
  } catch (error) {
    if (error instanceof CommitOutcomeUnknownError) {
      // The connection broke after COMMIT was sent: the order MAY be stored.
      // Look it up by a business key before trying again.
    }
    throw error;
  }
}
```

Для обычного случая этого достаточно: база drizzle (обязательно над `Pool`), работа через `tx`, а там, где важно
«могло зафиксироваться», — обработка `CommitOutcomeUnknownError`. Без опций нет ни повторов, ни лишних запросов:
BEGIN, работа, COMMIT.

## API

### `transactionKeepingFailure(db, work, options?)`

```text
transactionKeepingFailure<T, Db extends PoolDatabase, Tx extends TransactionHandle = TransactionOf<Db>>(
  db: Db, work: (tx: Tx, client: PoolClient) => Promise<T>, options?: TransactionOptions,
): Promise<T>
```

Выполняет `work` в транзакции на отдельном соединении пула и возвращает её результат.

- `db` — `drizzle(pool)` (что угодно с пулом pg в `$client`; пул распознаётся по форме, поэтому две копии `pg` в
  монорепозитории не мешают). Иначе — `Error` до запросов.
- `tx` — транзакция drizzle над тем же соединением; наследует диалект (`casing`), схему (`tx.query.*`), логгер и кэш
  базы. Тип выводится из ВАШЕЙ базы: `async (tx) => tx.insert(...)` компилируется без аннотаций. Работа, объявившая
  параметром корневой клиент вместо транзакции, не компилируется.
- `client` — `PoolClient` транзакции, для сырого SQL с `$1…$n` в ту же транзакцию. `client.release()`/
  `client.end()` и запрос через `client` или `tx` после возврата работы — `TransactionClientMisuseError`.
- Вложенный `tx.transaction(...)` — точка сохранения, как у drizzle.

Наружу всегда исходный отказ (или `wrapFailure(stage, error)` от него), а соединение либо вернулось в пул исправным,
либо уничтожено.

#### Опции (`TransactionOptions`)

| Опция | По умолчанию | Что делает |
|---|---|---|
| `isolationLevel` | уровень сервера | `ISOLATION_LEVEL.readCommitted` / `repeatableRead` / `serializable` |
| `readOnly` | `false` | `READ ONLY` |
| `deferrable` | `false` | `DEFERRABLE` (действует только в SERIALIZABLE READ ONLY; намеренно не проверяется — уровень может прийти из умолчаний сервера) |
| `lockTimeoutMs`, `statementTimeoutMs`, `idleInTransactionTimeoutMs` | не заданы | таймауты только на транзакцию (`set_config(…, true)`, все одним запросом). Целые `> 0` и `≤ POSTGRES_LIMIT.MAX_TIMEOUT_MS`; `0` — отказ (у Postgres это «без потолка») |
| `localSettings` | не заданы | свои параметры на транзакцию, например `{ 'app.tenant_id': id }`, тем же запросом, что таймауты. Одно имя в двух регистрах — отказ |
| `retry` | выключен | `{ attempts, backoffMs = 25, on = ['serialization', 'deadlock'], when? }` — повтор ВСЕЙ работы (ниже) |
| `signal` | — | `AbortSignal`: отменённый вызов не берёт соединение; ожидание соединения пула и пауза между повторами прерываются. Идущую попытку не прерывает |
| `wrapFailure` | как есть | `(stage, error) => unknown` — во что превратить отказ перед броском (например, в тип ошибки вашей ORM) |
| `nested` | `'refuse'` | вызов внутри работы другой транзакции того же пула: `NESTED_TRANSACTION.refuse` (`NestedTransactionError`) или `.savepoint` |
| `rollbackTimeoutMs` | 5000 (`TRANSACTION_DEFAULTS.ROLLBACK_TIMEOUT_MS`) | потолок ROLLBACK и уборки сессии; «молчащее» соединение уничтожается |
| `resetSession` | `false` | убрать сессионное состояние работы до возврата соединения в пул (раздел [«Сессионное состояние»](#сессионное-состояние-соединения-пула)) |
| `sessionBaseline` | `'connect'` | к чему возвращает `resetSession`: `SESSION_BASELINE.connect` или `.defaults`. Только вместе с `resetSession` |
| `transactionPooler` | `false` | защита для PgBouncer/Odyssey в transaction mode (раздел [«Под пулером»](#под-пулером-в-transaction-mode)) |
| `sessionStateCheck` | `true` | сверка состояния после транзакции под `transactionPooler`; только вместе с ним |
| `resetAppSettings` | не заданы | свои параметры (`префикс.имя`), которые после работы, до COMMIT, возвращаются к значению по умолчанию сессии |
| `observer` | — | `{ connectionAcquired({ waitMs }), connectionDestroyed({ stage, error }), attemptFailed({ attempt, stage, error, willRetry }) }` для метрик; отказ наблюдателя проглатывается |

Неверное значение любой опции — отказ до соединения. Под точкой сохранения опции уровня транзакции
(`isolationLevel`, `readOnly`, `deferrable`, таймауты, `retry`, `localSettings`, `resetAppSettings`, `resetSession`,
`sessionBaseline`, `rollbackTimeoutMs`, `sessionStateCheck`) — отказ: они принадлежат внешней. `observer` под точкой
сохранения не вызывается (своего соединения и попыток у неё нет).

**Повтор.** Выключен, пока не задан `retry`. Повтор выполняет работу заново целиком, поэтому она обязана быть
идемпотентной и без внешних побочных эффектов (HTTP, очереди). Причины (`RETRY_REASON`): `serialization` (40001),
`deadlock` (40P01), `lock-timeout` (55P03, в том числе `AdvisoryLockTimeoutError`), `connection-before-work`
(соединение не получено или BEGIN не прошёл по обрыву — безопасно и для неидемпотентной работы).
`retry.when(error, stage)` — своя классификация. SQLSTATE ищется и в цепочке `cause` (`DrizzleQueryError`,
`wrapFailure`). Пауза — full jitter `random × backoffMs × 2^(попытка−1)`. Не повторяются никогда:
`CommitOutcomeUnknownError`, `ManualTransactionControlError`, `SessionStateLeakError`, отказы после отмены `signal`.

<!-- example: examples/transaction-options.ts -->
```ts
import {
  ISOLATION_LEVEL,
  RETRY_REASON,
  TransactionRetryAbortedError,
  transactionKeepingFailure,
} from '@hoshinotatsuya/pg-runtime';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

type Db = NodePgDatabase & { $client: Pool };

export async function transfer(db: Db, from: number, to: number, amount: number, signal: AbortSignal) {
  try {
    await transactionKeepingFailure(
      db,
      async (tx) => {
        await tx.execute(sql`UPDATE accounts SET balance = balance - ${amount} WHERE id = ${from}`);
        await tx.execute(sql`UPDATE accounts SET balance = balance + ${amount} WHERE id = ${to}`);
      },
      {
        isolationLevel: ISOLATION_LEVEL.serializable,
        lockTimeoutMs: 2_000, // SET LOCAL lock_timeout
        statementTimeoutMs: 30_000, // SET LOCAL statement_timeout
        idleInTransactionTimeoutMs: 60_000, // SET LOCAL idle_in_transaction_session_timeout
        // The WHOLE work runs again on each retry: keep it idempotent and free of external side effects.
        retry: { attempts: 3, backoffMs: 50, on: [RETRY_REASON.serialization, RETRY_REASON.deadlock] },
        signal, // stops waiting for a connection and between retries
        observer: {
          connectionAcquired: ({ waitMs }) => console.log('pool wait', waitMs),
          connectionDestroyed: ({ stage, error }) =>
            console.warn('connection destroyed', stage, error.message),
          attemptFailed: ({ attempt, willRetry }) => console.warn('attempt failed', attempt, willRetry),
        },
      },
    );
  } catch (error) {
    if (error instanceof TransactionRetryAbortedError && error.reason === signal.reason) {
      return; // cancelled between attempts; error.cause holds the last failure (e.g. 40001)
    }
    throw error;
  }
}

/** Work that changes session state (SET, LISTEN, temp tables) — clean the connection before it returns to the pool. */
export function withSessionCleanup(db: Db) {
  return transactionKeepingFailure(
    db,
    async (tx) => {
      await tx.execute(sql`SET search_path = reporting, public`);
      await tx.execute(sql`SELECT 1`);
    },
    { resetSession: true }, // restores the state the connection had after pool.on('connect')
  );
}
```

#### Сырой SQL и точки сохранения

<!-- example: examples/raw-sql-and-savepoints.ts -->
```ts
import { NESTED_TRANSACTION, transactionKeepingFailure } from '@hoshinotatsuya/pg-runtime';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

type Db = NodePgDatabase & { $client: Pool };

export function markDone(db: Db, jobId: number) {
  // The second argument is the transaction's own PoolClient: raw SQL with $1…$n in the SAME transaction.
  // Never send BEGIN/COMMIT/ROLLBACK through it and never call client.release().
  return transactionKeepingFailure(db, async (tx, client) => {
    await client.query('UPDATE jobs SET status = $1 WHERE id = $2', ['done', jobId]);
    await tx.execute(sql`INSERT INTO job_events (job_id, kind) VALUES (${jobId}, 'done')`);
  });
}

export function auditInsideOuterTransaction(db: Db, jobId: number) {
  return transactionKeepingFailure(db, async () => {
    // A call inside the work of a transaction on the same pool throws NestedTransactionError by default.
    // With nested: savepoint it becomes a SAVEPOINT; its failure rolls back only the inner part.
    await transactionKeepingFailure(
      db,
      async (inner) => {
        await inner.execute(sql`INSERT INTO audit (job_id) VALUES (${jobId})`);
      },
      { nested: NESTED_TRANSACTION.savepoint },
    ).catch(() => undefined);
  });
}
```

### `withTenant(tx, tenantId, setting = 'app.tenant_id')`

Контекст RLS на ТЕКУЩУЮ транзакцию: `set_config(setting, tenantId, true)`. Обычный `SET` остался бы на соединении
пула и уехал бы следующему владельцу. Отказ до запроса: корневой клиент вместо транзакции, пустой идентификатор,
NUL или непарный суррогат в нём (`RangeError`), имя параметра без точки. Тот же контекст без лишнего запроса —
`localSettings`.

<!-- example: examples/tenant-context.ts -->
```ts
import { transactionKeepingFailure, withTenant } from '@hoshinotatsuya/pg-runtime';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

type Db = NodePgDatabase & { $client: Pool };

// RLS policy on the table, for example:
//   CREATE POLICY own ON notes USING (tenant = current_setting('app.tenant_id', true));
export function notesOf(db: Db, tenantId: string) {
  return transactionKeepingFailure(db, async (tx) => {
    await withTenant(tx, tenantId); // set_config('app.tenant_id', tenantId, true): this transaction only
    const result = await tx.execute<{ body: string }>(sql`SELECT body FROM notes ORDER BY body`);
    return result.rows.map((row) => row.body);
  });
}

// The same context without the extra round trip: sent together with the timeouts.
export function notesOfWithoutExtraQuery(db: Db, tenantId: string) {
  return transactionKeepingFailure(
    db,
    async (tx) => (await tx.execute<{ body: string }>(sql`SELECT body FROM notes`)).rows,
    { localSettings: { 'app.tenant_id': tenantId } },
  );
}
```

Проверено под ролью приложения без `SUPERUSER`/`BYPASSRLS` (суперпользователь обходит RLS, и проверка под ним
ничего не доказывает): следующая транзакция того же соединения контекста не видит.

### Advisory-локи

- `withAdvisoryLock(db, key, work, { timeoutMs, pollMs?, signal?, ...опции транзакции })` — `pg_advisory_xact_lock`
  первым оператором транзакции работы, снимается концом транзакции (и при обрыве тоже). Принимает все опции
  `transactionKeepingFailure`, кроме `nested`; `signal` прерывает и ожидание лока, повтор берёт лок заново.
- `withSessionAdvisoryLock(db | pool, key, work, { timeoutMs, pollMs?, signal?, transactionPooler? })` — сессионный
  лок на отдельном соединении; работа идёт ВНЕ транзакции (долгий процесс со своими транзакциями) и получает
  защищённое соединение. После работы — `pg_advisory_unlock` с потолком 5 с; не прошёл или ответил «не держали» —
  соединение уничтожается, лок снимает сервер вместе с сессией. Открытая или прерванная транзакция, оставленная
  работой, — `TransactionLeftOpenError`; разрыв сессии до возврата работы — `AdvisoryLockLostError` (взаимное
  исключение нарушено). Внутри транзакции того же пула — `NestedTransactionError`. С `transactionPooler: true` —
  `PoolerIncompatibleError` (сессионный лок за пулером в transaction mode не работает — нужен `withAdvisoryLock`).

Ключ (`AdvisoryLockKey`): безопасное целое, `bigint` (int8) или строка (`hashtextextended(ключ, 0)`, 64 бита). Не
взят за `timeoutMs` — `AdvisoryLockTimeoutError` (`key`, `timeoutMs`, `code = '55P03'`), работа не запускается.
`pollMs` по умолчанию 50 (`TRANSACTION_DEFAULTS.ADVISORY_LOCK_POLL_MS`).

<!-- example: examples/advisory-locks.ts -->
```ts
import {
  AdvisoryLockTimeoutError,
  withAdvisoryLock,
  withSessionAdvisoryLock,
} from '@hoshinotatsuya/pg-runtime';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

type Db = NodePgDatabase & { $client: Pool };

/** One invoice run per customer at a time; the lock is released by the end of the transaction. */
export async function runInvoicing(db: Db, customerId: number): Promise<'done' | 'busy'> {
  try {
    await withAdvisoryLock(
      db,
      `invoicing:${customerId}`, // string keys are hashed with hashtextextended (64 bits)
      async (tx) => {
        await tx.execute(sql`UPDATE invoices SET state = 'issued' WHERE customer_id = ${customerId}`);
      },
      { timeoutMs: 5_000 },
    );
    return 'done';
  } catch (error) {
    if (error instanceof AdvisoryLockTimeoutError) {
      return 'busy'; // another session holds the lock; the work did not run
    }
    throw error;
  }
}

/** A long process with its own transactions under a session lock held by a dedicated connection. */
export function rebuildSearchIndex(pool: Pool) {
  return withSessionAdvisoryLock(
    pool,
    'search-index-rebuild',
    async (client) => {
      await client.query('BEGIN');
      try {
        await client.query('DELETE FROM search_index');
        await client.query('INSERT INTO search_index SELECT id, body FROM documents');
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    },
    { timeoutMs: 60_000 },
  );
}
```

### Сессионное состояние соединения пула

Соединение транзакции — соединение ПУЛА: после `release` его получает следующий вызывающий вместе со всем
сессионным, что на нём оставила работа.

| Что оставила работа | Что увидит следующий владелец |
|---|---|
| `SET` без `LOCAL`, `set_config(…, false)` | чужие `search_path`, `statement_timeout`, `app.tenant_id` (RLS!) |
| `pg_advisory_lock` (сессионный) | чужой лок, который никто не снимет до конца сессии |
| `LISTEN` | чужие уведомления |
| `CREATE TEMP TABLE`, курсор `WITH HOLD` | чужие временные объекты |

Предпочтительны формы на транзакцию (`localSettings`, `withTenant`, `SET LOCAL`, `withAdvisoryLock`). Если работа
всё же меняет сессию — `resetSession: true`: после транзакции одним запросом `CLOSE ALL; SET SESSION AUTHORIZATION
DEFAULT; RESET ALL; UNLISTEN *; pg_advisory_unlock_all(); DISCARD TEMP; DISCARD SEQUENCES` (это `DISCARD ALL` без
`DEALLOCATE ALL`, который сломал бы именованные подготовленные операторы pg), затем восстановление базовой линии.
Уборка не прошла — соединение уничтожается.

`sessionBaseline: 'connect'` (по умолчанию) возвращает соединение к состоянию, в котором оно пришло в первую
транзакцию с `resetSession`: заданное в `pool.on('connect')` (`search_path`, `TimeZone`, `SET ROLE`, `LISTEN`)
остаётся. Снимок — один раз на соединение, тем же сообщением, что BEGIN: лишнего обращения к базе нет.
`'defaults'` — к значениям по умолчанию сессии. Ограничения `'connect'`:

- свой параметр (`app.*`), заданный через `SET` на connect, уборка НЕ восстановит — Postgres не показывает свои
  параметры в `pg_settings`. Задавайте такие параметры стартовым пакетом (`options: '-c app.x=…'`) или на транзакцию;
- временный объект, курсор `WITH HOLD` или сессионный лок, уже лежащие на соединении после connect, — отказ первой
  такой транзакции (уборка сняла бы их безвозвратно);
- обработчик connect обязан ставить запросы в очередь синхронно, как в документации pg-pool.

### Под пулером в transaction mode

За PgBouncer или Odyssey в **transaction mode** серверное соединение после каждой транзакции достаётся другому
клиенту, и всё сессионное, что на нём осталось, получает он. `transactionPooler: true` держит два рубежа:

1. **До отправки — по тексту запроса**: `PoolerIncompatibleError` (`problems: string[]`), запрос до сервера не
   доходит. `SET`/`RESET` без `LOCAL` (в том числе `SET ROLE`, `SET SESSION AUTHORIZATION`), `LISTEN`/`UNLISTEN`,
   `PREPARE`, `DEALLOCATE`, `DISCARD`, `LOAD`, курсор `WITH HOLD`, временные объекты, переживающие транзакцию,
   сессионные advisory-локи и `pg_advisory_unlock_all()`, `dblink_connect`, `pg_replication_origin_session_setup`,
   `set_config`, у которого `is_local` не доказан как `true` (литерал или ЗНАЧЕНИЕ параметра `$n`), именованные
   подготовленные операторы. Комментарии и содержимое строк в разбор не попадают; тело `$…$` — код только там, где
   Postgres его исполняет (`DO`, тело функции, `EXECUTE`). Неразобранный текст — отказ.
2. **После транзакции — по состоянию сервера**: `SessionStateLeakError` (`changes: { kind, item, change }[]`,
   `committed`, `verified`, `probeError`). Снимки идут тем же сообщением, что BEGIN и COMMIT/ROLLBACK, поэтому они с
   одного серверного соединения и без лишних обращений. Сравнивается разница: оставленное чужим клиентом пулера вам
   не вменяется. Ловит DO-блок, функцию, `EXECUTE 'SET …'`. Не повторяется никогда; при `committed: true` работа уже
   зафиксирована.

Законные формы проходят оба рубежа: `SET LOCAL`, `SET TRANSACTION`, `set_config(…, true)`, `CREATE TEMP TABLE … ON
COMMIT DROP`, `pg_advisory_xact_lock`, курсор без `WITH HOLD`, `localSettings`, `withTenant`, `withAdvisoryLock`,
любой `isolationLevel`. Первый запрос транзакции — снимок, поэтому вместо `SET TRANSACTION ISOLATION LEVEL` в работе —
опция `isolationLevel`; `SET TRANSACTION SNAPSHOT` не поддерживается. `resetSession` под `transactionPooler` — отказ
(уборка серверных соединений — дело пулера).

`assertPoolerCompatible(pool | db)` на старте проверяет, что параметры старта сессии (`options`,
`statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`) не заданы — ни в настройках пула, ни в
строке подключения, ни в `PGOPTIONS`, ни в `pg.defaults`: пулер их отвергает или молча теряет. Читает их тем же кодом,
что сам pg (`pg/lib/connection-parameters`).

`resetAppSettings: ['app.x', …]` — для библиотеки-обёртки со своими параметрами: пакет сам, мимо фильтра (из работы
та же форма — отказ), шлёт `set_config(имя, NULL, false)` для каждого имени, которое есть в сессии. Пропускается,
если транзакция уже прервана (ROLLBACK снимет всё сам).

<!-- example: examples/transaction-pooler.ts -->
```ts
import {
  assertPoolerCompatible,
  PoolerIncompatibleError,
  SessionStateLeakError,
  transactionKeepingFailure,
} from '@hoshinotatsuya/pg-runtime';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

// Behind PgBouncer/Odyssey in transaction mode. Fails at startup on startup parameters
// (options, statement_timeout, PGOPTIONS, pg.defaults) that the pooler rejects or silently drops.
export function createPoolerDb(connectionString: string) {
  const pool = new Pool({ connectionString, max: 20, query_timeout: 10_000 });
  assertPoolerCompatible(pool);
  return drizzle(pool);
}

export async function touch(db: ReturnType<typeof createPoolerDb>, id: number) {
  try {
    await transactionKeepingFailure(
      db,
      async (tx) => {
        await tx.execute(sql`SET LOCAL work_mem = '64MB'`); // allowed: transaction-scoped
        await tx.execute(sql`UPDATE items SET touched_at = now() WHERE id = ${id}`);
      },
      { transactionPooler: true, resetAppSettings: ['app.request_reason'] },
    );
  } catch (error) {
    if (error instanceof PoolerIncompatibleError) {
      // A session-level statement (SET without LOCAL, LISTEN, PREPARE, …) was refused before it was sent.
    }
    if (error instanceof SessionStateLeakError) {
      // The work changed server session state bypassing the text filter (DO block, function, EXECUTE).
      // error.committed tells whether the work was committed; error.changes lists what changed.
    }
    throw error;
  }
}
```

Чего защита НЕ ловит (названо, чтобы на неё не ссылались):

- свои параметры (`app.*`), заданные через DO/функцию/`EXECUTE`, — Postgres скрывает их из `pg_settings` и
  `SHOW ALL`; для них — `resetAppSettings`;
- состояние последовательностей (`currval`/`lastval`) — его оставляет каждая вставка в `serial`-колонку;
- после `set_config('app.x', …, true)` параметр остаётся ОБЪЯВЛЕННЫМ с пустым значением: у соседа
  `current_setting('app.x', true)` даёт `''`, а не NULL. Политики RLS пишите с `NULLIF(…, '')`;
- повторно взятый сессионный лок, который уже держал другой клиент пулера (`pg_locks` без счётчика);
- `LOAD`, соединения `dblink`/`postgres_fdw`, источник репликации — только по тексту;
- транзакцию, которую работа завершила сама, и отказ COMMIT — сверять не с чем;
- `SET` обработчика connect для параметров, которые пулер не отслеживает (`statement_timeout`, `work_mem`,
  `search_path` ниже Postgres 18), остаётся на серверном соединении — задавайте их на роль/базу или на транзакцию.

Цена (Postgres 17 в docker на ноутбуке, пул 10, один INSERT на транзакцию): лишних обращений сверка не добавляет, но
снимок — около 0,5 мс работы сервера; пропускная способность 0,58 / 3,0 / 2,9 тыс./с при 1 / 10 / 50 параллельных
против 2,2 / 8,9 / 8,9 тыс./с без неё. Один фильтр текста (`sessionStateCheck: false`) — в пределах шума.

### `poolStats(pool | db)`

`{ total, idle, inUse, waiting }` пула pg — вместе с `observer` отличает «база медленная» от «пул мал».

### Ошибки

Тексты ошибок сейчас на русском; сверяйте класс и поля, а не текст.

| Класс | Когда | Поля | Повтор |
|---|---|---|---|
| `CommitRolledBackError` | сервер ответил на COMMIT ROLLBACK (работа проглотила отказ запроса) | — | нет |
| `CommitOutcomeUnknownError` | обрыв после отправки COMMIT: **могло зафиксироваться** | `cause` | никогда |
| `TransactionConnectionLostError` | сервер разорвал сессию во время транзакции | `stage`, `cause`, `workError` | только обрыв до начала работы, с `retry.on: ['connection-before-work']` |
| `AdvisoryLockLostError` | разрыв сессии во время работы `withSessionAdvisoryLock` | `lock`, `stage`, `cause`, `workError` | нет |
| `TransactionLeftOpenError` | работа `withSessionAdvisoryLock` оставила открытую или прерванную транзакцию | `lock`, `cause` | нет |
| `AdvisoryLockTimeoutError` | лок не взят за `timeoutMs`; работа не запускалась | `key`, `timeoutMs`, `code = '55P03'` | с `retry.on: ['lock-timeout']` |
| `NestedTransactionError` | вызов внутри транзакции того же пула | — | нет |
| `TransactionClientMisuseError` | `release()`/`end()` в работе или запрос после её конца | `misuse` (`CLIENT_MISUSE`) | нет |
| `ManualTransactionControlError` | работа сама послала `COMMIT`/`ROLLBACK` (по предупреждению 25P01) | `cause` | никогда |
| `TransactionRetryAbortedError` | `signal` отменил паузу между повторами | `reason`, `cause` (последний отказ) | — |
| `TransactionCallbackError` | бросил `retry.when` или `wrapFailure` | `callback`, `callbackError`, `cause` | нет |
| `PoolerIncompatibleError` | сессионный оператор или настройка под `transactionPooler` | `problems` | нет |
| `SessionStateLeakError` | состояние серверной сессии изменилось за транзакцию | `changes`, `committed`, `verified`, `probeError` | никогда |
| `Error` / `RangeError` | неверные аргументы или опции, база не над пулом | — | — |

### Константы и типы

Константы (заморожены глубоко): `ISOLATION_LEVEL`, `NESTED_TRANSACTION`, `RETRY_REASON`, `RETRYABLE_SQLSTATE`,
`SESSION_BASELINE`, `SESSION_STATE_KIND`, `CLIENT_MISUSE`, `TRANSACTION_STAGE` (`BEGIN` / `work` / `COMMIT` — стадия
для `wrapFailure`, `retry.when` и наблюдателя), `TRANSACTION_COMMAND`, `TRANSACTION_DEFAULTS`
(`ROLLBACK_TIMEOUT_MS = 5000`, `ADVISORY_LOCK_POLL_MS = 50`, `TENANT_SETTING = 'app.tenant_id'`), `POSTGRES_LIMIT`
(`MAX_TIMEOUT_MS`), `TIMER_LIMIT` (`MAX_DELAY_MS`).

Типы: `TransactionOptions`, `RetryOptions`, `RetryReason`, `TransactionObserver`, `TransactionStage`,
`NestedTransaction`, `SessionBaseline`, `SessionStateChange`, `SessionStateKind`, `AdvisoryLockKey`,
`AdvisoryLockOptions`, `AdvisoryXactLockOptions`, `ClientMisuse`, `PoolDatabase`, `PoolStats`, `SqlExecutor`,
`TransactionHandle`, `TransactionOf<Db>` (тип транзакции вашей базы).

## Гарантии и пределы

Гарантируется (у каждого пункта есть тест на настоящей базе, и он краснеет, если снять правку):

- соединение возвращается в пул исправным или уничтожается — никогда не уходит с открытой транзакцией, непрошедшим
  откатом, сессионным локом или (с `resetSession`) сессионным состоянием работы;
- наружу — исходный отказ; «зафиксировано или нет» не угадывается: если исход неизвестен — `CommitOutcomeUnknownError`;
- параметры на транзакцию не достаются следующему владельцу соединения;
- работа не выполняется дважды, если вы не включили `retry`, а исходы, которые повтор мог бы задвоить, не повторяются.

Пределы:

- **Задайте пулу `query_timeout`.** BEGIN и COMMIT, как и запросы работы, своего потолка не имеют: на замёрзшей сети
  их ограничивает только `query_timeout` pg (без него вызов висит до таймаута TCP ОС).
- `COMMIT; BEGIN` внутри работы не распознаётся: наш COMMIT закрывает вторую транзакцию.
- Распознавание ручного `COMMIT`/`ROLLBACK` опирается на предупреждение 25P01: при `client_min_messages = error` на
  роли его не будет.
- Две копии пакета в одном процессе друг друга не видят (вложенность — по `AsyncLocalStorage` своей копии).
- `signal` не прерывает идущую попытку: работа слушает сигнал сама.
- Odyssey не проверялся (нет официального образа); PgBouncer 1.26.1 — проверен.

Накладные расходы (Postgres 17 в docker на ноутбуке, пул 10, один INSERT на транзакцию): сама обёртка — в пределах
шума замера относительно `db.transaction` (1,8–2,1 / 4,8–4,9 / 5,4–5,5 тыс./с при 1 / 10 / 50 параллельных). Таймауты
стоят одно обращение на все (≈25% для транзакции из одного запроса, единицы процентов для десяти). Выше `max` пула
транзакции ждут соединения. Воспроизвести: `pnpm build && scripts/with-postgres.sh node bench/capacity.cjs`.

## Совместимость

- Node.js ≥ 24.
- Postgres 15, 16, 17, 18 (полный набор идёт на каждой, с PgBouncer 1.26.1 перед ней).
- drizzle-orm `>=0.45.2 <0.46`, pg `^8.18.0`, TypeScript 5.9 – 7 (матрица потребителей: `commonjs`, `node16`,
  `nodenext`, `bundler` + ESM, `nodenext` + ESM, последние drizzle-orm/pg, TypeScript 7; с ts-jest 29).

## Поведение при отказе

Пакет закрыт по умолчанию: то, что нельзя доказать безопасным, отвергается, а не пропускается.

- Неверные опции, неизвестное значение перечисления, пустой арендатор, база не над пулом — отказ до соединения.
- Под `transactionPooler` неразобранный текст запроса — отказ; `set_config` с `is_local`, не доказанным как `true`, —
  отказ.
- Соединение в неизвестном состоянии (откат не прошёл, уборка не прошла, снятие лока не ответило, опрос по потолку)
  уничтожается, а не используется снова.
- Неизвестный исход COMMIT сообщается как неизвестный, а не как отказ или успех.

## Тесты и разработка

```sh
pnpm install
pnpm test               # поднимает postgres:17 и PgBouncer 1.26.1 в docker, гонит набор группами
pnpm run test:consumers # пакует пакет и компилирует его в одноразовых проектах потребителей
pnpm typecheck          # исходники и examples/
pnpm lint
pnpm build
```

`pnpm test` нужен Docker. Jest идёт через `jest-groups`: группы не больше 300 тестов, не больше двух воркеров,
строго одна за другой; пропущенные тесты — отказ. Заданы `PG_TEST_URL` и `PG_POOLER_URL` (адрес суперпользователя
Postgres и та же база через PgBouncer в transaction mode с одним серверным соединением на базу) — docker не нужен;
`PG_TEST_IMAGE` — другой образ Postgres. `test:consumers` нужен доступ к реестру npm.

## Лицензия

[MIT](LICENSE) © 2026 Hoshino Tatsuya
