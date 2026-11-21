# @hoshinotatsuya/pg-runtime

[![npm](https://img.shields.io/npm/v/@hoshinotatsuya/pg-runtime.svg)](https://www.npmjs.com/package/@hoshinotatsuya/pg-runtime)
[![CI](https://github.com/HoshinoTatsuya/pg-runtime/actions/workflows/ci.yml/badge.svg)](https://github.com/HoshinoTatsuya/pg-runtime/actions/workflows/ci.yml)

[Русская версия](README.ru.md) · [Changelog](CHANGELOG.md)

Postgres transactions for [drizzle-orm](https://orm.drizzle.team) over [node-postgres](https://node-postgres.com)
that never leak, poison or misreport a pool connection.

`db.transaction` in drizzle-orm 0.45.2 has defects that only show up when something goes wrong — which is
exactly when you need the transaction layer to be right:

| `db.transaction` | `transactionKeepingFailure` |
|---|---|
| BEGIN runs before `try`: if it fails, the connection is never returned to the pool (ten such failures hang every database call) | BEGIN is inside `try`; the connection always goes back |
| a COMMIT failure on a broken connection is replaced by the ROLLBACK failure | you get the original failure |
| a connection whose ROLLBACK failed goes back to the pool as healthy | `release(error)`: the pool destroys it |
| COMMIT answered with ROLLBACK (the work caught a failed query) counts as success while nothing was stored | `CommitRolledBackError` |
| a connection lost after COMMIT was sent is reported as a plain failure | `CommitOutcomeUnknownError`: "may be committed", never retried |
| the server closing an idle session (`idle_in_transaction_session_timeout`, failover) crashes the process with an unhandled `'error'` event | `TransactionConnectionLostError` |
| a nested call on the same pool waits for a second connection: with `max` concurrent callers the pool deadlocks | `NestedTransactionError`, or a savepoint on request |

On top of that the package gives you transaction-scoped settings and timeouts, retries on serialization
failures and deadlocks, RLS tenant context, advisory locks with a timeout, and guards for running behind
PgBouncer in transaction mode. Everything is tested against a real Postgres and a real PgBouncer.

## Install

```sh
pnpm add @hoshinotatsuya/pg-runtime drizzle-orm pg
pnpm add -D @types/pg
```

Peer dependencies: `drizzle-orm >=0.45.2 <0.46`, `pg ^8.18.0`, and optionally `@types/pg >=8.15.0`.
The package is CommonJS with separate declarations for `import` (`.d.mts`) and `require` (`.d.ts`), so it works
from CommonJS and ESM projects (`node16`, `nodenext`, `bundler`).

## Quick start

<!-- the code below is examples/quick-start.ts, type-checked and run against Postgres in the test suite -->
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

That is all you need for the common case: pass the drizzle database (it must be built over a `Pool`), do the work
with `tx`, and handle `CommitOutcomeUnknownError` wherever "maybe committed" matters. Without options there are
no retries and no extra queries: BEGIN, your work, COMMIT.

## API

### `transactionKeepingFailure(db, work, options?)`

```text
transactionKeepingFailure<T, Db extends PoolDatabase, Tx extends TransactionHandle = TransactionOf<Db>>(
  db: Db, work: (tx: Tx, client: PoolClient) => Promise<T>, options?: TransactionOptions,
): Promise<T>
```

Runs `work` in a transaction on a dedicated pool connection and returns its result.

- `db` — `drizzle(pool)` (anything with a pg `Pool` in `$client`; the pool is detected by shape, so two copies of
  `pg` in a monorepo are fine). Otherwise: `Error` before any query.
- `tx` — a drizzle transaction over the same connection; it inherits the database's dialect (`casing`), schema
  (`tx.query.*`), logger and cache. Its type is inferred from **your** database, so `async (tx) => tx.insert(...)`
  compiles without annotations. Declaring the root client type instead of a transaction does not compile.
- `client` — the transaction's `PoolClient`, for raw SQL with `$1…$n` in the same transaction. Calling
  `client.release()`/`client.end()` or querying through `client` or `tx` after the work returned is
  `TransactionClientMisuseError`.
- A nested `tx.transaction(...)` is a savepoint, as in drizzle.

The failure you get is always the original one (or `wrapFailure(stage, error)` of it), and the connection is
either back in the pool healthy or destroyed.

#### Options (`TransactionOptions`)

| Option | Default | Meaning |
|---|---|---|
| `isolationLevel` | server default | `ISOLATION_LEVEL.readCommitted` / `repeatableRead` / `serializable` |
| `readOnly` | `false` | `READ ONLY` |
| `deferrable` | `false` | `DEFERRABLE` (effective only in SERIALIZABLE READ ONLY; not validated on purpose — the level may come from server defaults) |
| `lockTimeoutMs`, `statementTimeoutMs`, `idleInTransactionTimeoutMs` | not set | transaction-scoped timeouts (`set_config(…, true)`, one query for all). Integers `> 0` and `≤ POSTGRES_LIMIT.MAX_TIMEOUT_MS`; `0` is refused (it means "no limit" in Postgres) |
| `localSettings` | not set | your own transaction-scoped parameters, e.g. `{ 'app.tenant_id': id }`, sent in the same query as the timeouts. The same name in two cases is refused |
| `retry` | off | `{ attempts, backoffMs = 25, on = ['serialization', 'deadlock'], when? }` — re-runs the **whole** work (see below) |
| `signal` | — | `AbortSignal`: a cancelled call does not connect; waiting for a pool connection and the pause between retries are interrupted. A running attempt is not interrupted |
| `wrapFailure` | identity | `(stage, error) => unknown` — convert the failure before it is thrown (e.g. into your ORM's error type) |
| `nested` | `'refuse'` | what a call inside the work of another transaction on the same pool does: `NESTED_TRANSACTION.refuse` (`NestedTransactionError`) or `.savepoint` |
| `rollbackTimeoutMs` | 5000 (`TRANSACTION_DEFAULTS.ROLLBACK_TIMEOUT_MS`) | ceiling on ROLLBACK and session cleanup; a silent connection is destroyed |
| `resetSession` | `false` | clean session state left by the work before the connection returns to the pool (see [Session state](#session-state-of-pool-connections)) |
| `sessionBaseline` | `'connect'` | what `resetSession` restores: `SESSION_BASELINE.connect` or `.defaults`. Only with `resetSession` |
| `transactionPooler` | `false` | guards for PgBouncer/Odyssey in transaction mode (see [Behind a transaction pooler](#behind-a-transaction-pooler)) |
| `sessionStateCheck` | `true` | the after-transaction state check under `transactionPooler`; only with `transactionPooler` |
| `resetAppSettings` | not set | your own parameters (`prefix.name`) reset to the session default after the work, before COMMIT |
| `observer` | — | `{ connectionAcquired({ waitMs }), connectionDestroyed({ stage, error }), attemptFailed({ attempt, stage, error, willRetry }) }` for metrics; observer failures are swallowed |

Every invalid option value is refused before a connection is taken. Under a savepoint, transaction-level options
(`isolationLevel`, `readOnly`, `deferrable`, the timeouts, `retry`, `localSettings`, `resetAppSettings`,
`resetSession`, `sessionBaseline`, `rollbackTimeoutMs`, `sessionStateCheck`) are refused: they belong to the outer
transaction. `observer` is not called for a savepoint (it has no connection or attempts of its own).

**Retries.** Off unless `retry` is set. A retry runs the work again from the start, so the work must be idempotent
and free of external side effects (HTTP calls, queue messages). Reasons (`RETRY_REASON`): `serialization`
(40001), `deadlock` (40P01), `lock-timeout` (55P03, also `AdvisoryLockTimeoutError`), `connection-before-work`
(no connection or BEGIN lost — safe even for non-idempotent work). `retry.when(error, stage)` adds your own
classification. SQLSTATE is found through `cause` chains (`DrizzleQueryError`, `wrapFailure`). The pause is full
jitter `random × backoffMs × 2^(attempt−1)`. Never retried: `CommitOutcomeUnknownError`,
`ManualTransactionControlError`, `SessionStateLeakError`, failures after `signal` was aborted.

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

#### Raw SQL and savepoints

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

Sets the RLS context for the **current transaction**: `set_config(setting, tenantId, true)`. A plain `SET` would
stay on the pool connection and reach the next caller. Refused before any query: a root client instead of a
transaction, an empty id, an id with NUL or a lone surrogate (`RangeError`), a setting name without a dot. The same
context without the extra query is `localSettings`.

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

Tested under an application role without `SUPERUSER`/`BYPASSRLS` (a superuser bypasses RLS and would make such a
test meaningless): the next transaction on the same connection does not see the context.

### Advisory locks

- `withAdvisoryLock(db, key, work, { timeoutMs, pollMs?, signal?, ...transactionOptions })` —
  `pg_advisory_xact_lock` taken as the first statement of the work's transaction and released by its end (also on a
  dropped connection). Accepts every `transactionKeepingFailure` option except `nested`; `signal` also interrupts
  waiting for the lock, and a retry retakes the lock.
- `withSessionAdvisoryLock(db | pool, key, work, { timeoutMs, pollMs?, signal?, transactionPooler? })` — a session
  lock on a dedicated connection; the work runs **outside** a transaction (a long process with its own
  transactions) and receives the guarded client. After the work: `pg_advisory_unlock` with a 5 s ceiling; if it
  fails or reports "not held", the connection is destroyed and the server releases the lock with the session.
  An open or aborted transaction left by the work is `TransactionLeftOpenError`; a session break before the work
  returned is `AdvisoryLockLostError` (mutual exclusion was violated). Inside a transaction of the same pool:
  `NestedTransactionError`. With `transactionPooler: true`: `PoolerIncompatibleError` (a session lock cannot work
  behind a transaction pooler — use `withAdvisoryLock`).

Keys (`AdvisoryLockKey`): a safe integer, a `bigint` (int8) or a string (`hashtextextended(key, 0)`, 64 bits).
Not acquired within `timeoutMs` → `AdvisoryLockTimeoutError` (`key`, `timeoutMs`, `code = '55P03'`), the work does
not run. `pollMs` defaults to 50 (`TRANSACTION_DEFAULTS.ADVISORY_LOCK_POLL_MS`).

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

### Session state of pool connections

A transaction's connection belongs to the pool: after `release` the next caller gets it, together with everything
session-level the work left on it.

| Left by the work | Seen by the next owner |
|---|---|
| `SET` without `LOCAL`, `set_config(…, false)` | someone else's `search_path`, `statement_timeout`, `app.tenant_id` (RLS!) |
| `pg_advisory_lock` (session) | a lock nobody releases until the session ends |
| `LISTEN` | someone else's notifications |
| `CREATE TEMP TABLE`, `WITH HOLD` cursor | someone else's temporary objects |

Prefer transaction-scoped forms (`localSettings`, `withTenant`, `SET LOCAL`, `withAdvisoryLock`). If the work must
change the session, use `resetSession: true`: after the transaction one query runs `CLOSE ALL; SET SESSION
AUTHORIZATION DEFAULT; RESET ALL; UNLISTEN *; pg_advisory_unlock_all(); DISCARD TEMP; DISCARD SEQUENCES` (that is
`DISCARD ALL` without `DEALLOCATE ALL`, which would break pg's named prepared statements), then restores the
baseline. If cleanup fails, the connection is destroyed.

`sessionBaseline: 'connect'` (default) restores the state the connection had when it entered its first
`resetSession` transaction — what `pool.on('connect')` set (`search_path`, `TimeZone`, `SET ROLE`, `LISTEN`) is
kept. The snapshot is taken once per connection in the same message as BEGIN, so there is no extra round trip.
`'defaults'` resets to session defaults. Limits of `'connect'`:

- custom parameters (`app.*`) set with `SET` in the connect handler are **not** restored — Postgres does not list
  them in `pg_settings`. Set them through startup options (`options: '-c app.x=…'`) or per transaction;
- a temporary object, `WITH HOLD` cursor or session lock already present after connect fails the first such
  transaction (cleanup would drop it irreversibly);
- the connect handler must queue its queries synchronously, as pg-pool documents.

### Behind a transaction pooler

Behind PgBouncer or Odyssey in **transaction mode** a server connection goes to another client after every
transaction, and any session state left on it goes along. `transactionPooler: true` adds two lines of defence:

1. **Before sending, by query text** — `PoolerIncompatibleError` (`problems: string[]`), the query never reaches
   the server: `SET`/`RESET` without `LOCAL` (including `SET ROLE`, `SET SESSION AUTHORIZATION`), `LISTEN`/
   `UNLISTEN`, `PREPARE`, `DEALLOCATE`, `DISCARD`, `LOAD`, `WITH HOLD` cursors, temporary objects that outlive the
   transaction, session advisory locks and `pg_advisory_unlock_all()`, `dblink_connect`,
   `pg_replication_origin_session_setup`, `set_config` whose `is_local` is not proven `true` (a literal or the
   **value** of a `$n` parameter), named prepared statements. Comments and string contents are not parsed as
   code; `$…$` bodies are code only where Postgres executes them (`DO`, function bodies, `EXECUTE`). Unparseable
   text is refused.
2. **After the transaction, by server state** — `SessionStateLeakError` (`changes: { kind, item, change }[]`,
   `committed`, `verified`, `probeError`). Snapshots go in the same message as BEGIN and as COMMIT/ROLLBACK, so
   they come from the same server connection with no extra round trips. Only the difference is reported, so state
   left by other pooler clients is not blamed on you. This catches DO blocks, functions and `EXECUTE 'SET …'`.
   Never retried; with `committed: true` the work is already committed.

Allowed forms pass both lines: `SET LOCAL`, `SET TRANSACTION`, `set_config(…, true)`, `CREATE TEMP TABLE … ON
COMMIT DROP`, `pg_advisory_xact_lock`, cursors without `WITH HOLD`, `localSettings`, `withTenant`,
`withAdvisoryLock`, any `isolationLevel`. Because the first statement of the transaction is the snapshot, use the
`isolationLevel` option instead of `SET TRANSACTION ISOLATION LEVEL` in the work; `SET TRANSACTION SNAPSHOT` is not
supported. `resetSession` is refused under `transactionPooler` (cleaning server connections is the pooler's job).

`assertPoolerCompatible(pool | db)` checks at startup that no session startup parameters (`options`,
`statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`) are configured — in the pool config, the
connection string, `PGOPTIONS` or `pg.defaults` — because a pooler rejects or silently drops them. It reads them
with pg's own code (`pg/lib/connection-parameters`).

`resetAppSettings: ['app.x', …]` lets a wrapper library reset its own parameters after the work: the package sends
`set_config(name, NULL, false)` itself (bypassing the filter that would refuse it from the work) for each name
present in the session. Skipped when the transaction is already aborted (ROLLBACK cleans up anyway).

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

What the guards do **not** catch (documented so nobody relies on it):

- custom parameters (`app.*`) set through DO/functions/`EXECUTE` — Postgres hides them from `pg_settings` and
  `SHOW ALL`; use `resetAppSettings`;
- sequence state (`currval`/`lastval`) — every insert into a `serial` column leaves it;
- after `set_config('app.x', …, true)` the parameter stays **declared** with an empty value: a neighbour's
  `current_setting('app.x', true)` returns `''`, not NULL. Write RLS policies with `NULLIF(…, '')`;
- a session lock re-taken that another pooler client already held (`pg_locks` has no counter);
- `LOAD`, `dblink`/`postgres_fdw` connections, replication origins — text only;
- transactions the work ended itself and failed COMMITs — nothing to compare against;
- connect-handler `SET`s of parameters the pooler does not track (`statement_timeout`, `work_mem`, `search_path`
  below Postgres 18) stay on the server connection — set them per role/database or per transaction.

Cost (Postgres 17 in docker on a laptop, pool 10, one INSERT per transaction): the state check adds no round trips
but ≈0.5 ms of server time per snapshot; throughput 0.58 / 3.0 / 2.9 k tx/s at 1 / 10 / 50 concurrent versus 2.2 /
8.9 / 8.9 k tx/s without it. The text filter alone (`sessionStateCheck: false`) is within noise.

### `poolStats(pool | db)`

Returns `{ total, idle, inUse, waiting }` for the pg pool — together with `observer`, this separates "the database
is slow" from "the pool is too small".

### Errors

Error messages are currently written in Russian; match on classes and fields, not on message text.

| Class | When | Fields | Retried |
|---|---|---|---|
| `CommitRolledBackError` | the server answered COMMIT with ROLLBACK (the work swallowed a failed query) | — | no |
| `CommitOutcomeUnknownError` | the connection broke after COMMIT was sent: **may be committed** | `cause` | never |
| `TransactionConnectionLostError` | the server closed the session during the transaction | `stage`, `cause`, `workError` | only if lost before the work started, with `retry.on: ['connection-before-work']` |
| `AdvisoryLockLostError` | session lost during `withSessionAdvisoryLock` work | `lock`, `stage`, `cause`, `workError` | no |
| `TransactionLeftOpenError` | `withSessionAdvisoryLock` work left a transaction open or aborted | `lock`, `cause` | no |
| `AdvisoryLockTimeoutError` | lock not acquired within `timeoutMs`; the work did not run | `key`, `timeoutMs`, `code = '55P03'` | with `retry.on: ['lock-timeout']` |
| `NestedTransactionError` | a call inside a transaction on the same pool | — | no |
| `TransactionClientMisuseError` | `release()`/`end()` in the work, or a query after the work ended | `misuse` (`CLIENT_MISUSE`) | no |
| `ManualTransactionControlError` | the work sent `COMMIT`/`ROLLBACK` itself (detected by warning 25P01) | `cause` | never |
| `TransactionRetryAbortedError` | `signal` aborted during the pause between retries | `reason`, `cause` (last failure) | — |
| `TransactionCallbackError` | `retry.when` or `wrapFailure` threw | `callback`, `callbackError`, `cause` | no |
| `PoolerIncompatibleError` | session-level statement or setting under `transactionPooler` | `problems` | no |
| `SessionStateLeakError` | server session state changed during the transaction | `changes`, `committed`, `verified`, `probeError` | never |
| `Error` / `RangeError` | invalid arguments or options, database not over a pool | — | — |

### Constants and types

Constants (deep-frozen): `ISOLATION_LEVEL`, `NESTED_TRANSACTION`, `RETRY_REASON`, `RETRYABLE_SQLSTATE`,
`SESSION_BASELINE`, `SESSION_STATE_KIND`, `CLIENT_MISUSE`, `TRANSACTION_STAGE` (`BEGIN` / `work` / `COMMIT` — the
stage passed to `wrapFailure`, `retry.when` and the observer), `TRANSACTION_COMMAND`, `TRANSACTION_DEFAULTS`
(`ROLLBACK_TIMEOUT_MS = 5000`, `ADVISORY_LOCK_POLL_MS = 50`, `TENANT_SETTING = 'app.tenant_id'`), `POSTGRES_LIMIT`
(`MAX_TIMEOUT_MS`), `TIMER_LIMIT` (`MAX_DELAY_MS`).

Types: `TransactionOptions`, `RetryOptions`, `RetryReason`, `TransactionObserver`, `TransactionStage`,
`NestedTransaction`, `SessionBaseline`, `SessionStateChange`, `SessionStateKind`, `AdvisoryLockKey`,
`AdvisoryLockOptions`, `AdvisoryXactLockOptions`, `ClientMisuse`, `PoolDatabase`, `PoolStats`, `SqlExecutor`,
`TransactionHandle`, `TransactionOf<Db>` (the transaction type of your database).

## Guarantees & limits

Guaranteed (each item has a test on a real database, and the test was shown to fail when the fix is removed):

- the connection is returned to the pool healthy or destroyed — never returned with an open transaction, a failed
  rollback, a session lock or (with `resetSession`) the work's session state;
- the failure you receive is the original one; "committed or not" is never guessed — when it is unknown you get
  `CommitOutcomeUnknownError`;
- transaction-scoped settings never reach the next owner of the connection;
- no work runs twice unless you enabled `retry`, and outcomes that a retry could duplicate are never retried.

Limits:

- **Set `query_timeout` on the pool.** BEGIN and COMMIT, like the work's queries, have no ceiling of their own; on a
  frozen network only pg's `query_timeout` bounds them (without it a call hangs until the OS TCP timeout).
- `COMMIT; BEGIN` inside the work is not detected: our COMMIT closes the second transaction.
- Detecting manual `COMMIT`/`ROLLBACK` relies on warning 25P01; with `client_min_messages = error` on the role it
  is not visible.
- Two copies of this package in one process do not see each other's transactions (nesting detection uses
  `AsyncLocalStorage` per copy).
- `signal` does not interrupt a running attempt: the work must listen to it itself.
- Odyssey is not tested (no official image); PgBouncer 1.26.1 is.

Overhead (Postgres 17 in docker on a laptop, pool 10, one INSERT per transaction): the wrapper itself is within
measurement noise of `db.transaction` (1.8–2.1 / 4.8–4.9 / 5.4–5.5 k tx/s at 1 / 10 / 50 concurrent). Timeouts cost
one round trip for all of them (≈25% for a one-query transaction, a few percent for ten queries). Above the pool's
`max`, transactions queue for connections. Reproduce with `pnpm build && scripts/with-postgres.sh node
bench/capacity.cjs`.

## Compatibility

- Node.js ≥ 24.
- Postgres 15, 16, 17, 18 (the full suite runs on each, with PgBouncer 1.26.1 in front).
- drizzle-orm `>=0.45.2 <0.46`, pg `^8.18.0`, TypeScript 5.9 – 7 (the consumer matrix covers `commonjs`, `node16`,
  `nodenext`, `bundler` + ESM, `nodenext` + ESM, latest drizzle-orm/pg, TypeScript 7; ts-jest 29 included).

## Failure behavior

The package fails closed: anything it cannot prove safe is refused, not let through.

- Invalid options, an unknown enum value, an empty tenant id, a database not over a pool — an error before a
  connection is taken.
- Under `transactionPooler`, query text that cannot be parsed is refused; `set_config` with an `is_local` that is
  not provably `true` is refused.
- A connection whose state is uncertain (failed ROLLBACK, failed cleanup, unanswered unlock, timed-out poll) is
  destroyed rather than reused.
- An unknown COMMIT outcome is reported as unknown, not as failure or success.

## Testing & development

```sh
pnpm install
pnpm test               # starts postgres:17 and PgBouncer 1.26.1 in docker, runs the suite in groups
pnpm run test:consumers # packs the package and compiles it in throwaway consumer projects
pnpm typecheck          # sources and examples/
pnpm lint
pnpm build
```

`pnpm test` needs Docker. It runs Jest through `jest-groups`: groups of at most 300 tests, at most two workers,
strictly one group after another, and fails on skipped tests. With `PG_TEST_URL` and `PG_POOLER_URL` set (a Postgres
superuser URL and the same database through PgBouncer in transaction mode with one server connection per database)
no Docker is started; `PG_TEST_IMAGE` selects another Postgres image. `test:consumers` needs network access to the
npm registry.

## License

[MIT](LICENSE) © 2026 Hoshino Tatsuya
