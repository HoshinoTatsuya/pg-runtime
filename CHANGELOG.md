# Changelog

All notable changes to `@hoshinotatsuya/pg-runtime` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[Semantic Versioning](https://semver.org/) with the pre-1.0 convention: a **minor** bump may break the API,
a **patch** bump never does. Every breaking release has a "Migration" subsection.

## [0.9.1] - 2026-11-21

### Changed

- First public release as `@hoshinotatsuya/pg-runtime`, MIT; documentation in English (`README.md`) and
  Russian (`README.ru.md`), this changelog; no functional changes.
- README code samples live in `examples/*.ts`: they are type-checked against the real API by
  `pnpm typecheck`, the README is checked to quote them verbatim, and two of them run against a real
  Postgres in the test suite.
- Dev dependencies: `@hoshinotatsuya/arch-gates` 0.12.2, `@hoshinotatsuya/jest-groups` 0.7.2.
- CI moved to GitHub Actions (`ci.yml`: typecheck, lint, tests on Postgres + PgBouncer, consumer matrix,
  build; `release.yml`: npm trusted publishing on a `vX.Y.Z` tag).

## [0.9.0] - 2026-11-21

New refusals where there used to be a silent success. Breaking changes are marked **(breaking)**.

### Fixed

- `withSessionAdvisoryLock` no longer returns a connection with an open transaction to the pool. After the
  work, a parameterless simple-protocol query `SELECT now() <> statement_timestamp()` detects an open or
  aborted (25P02) transaction; the connection is destroyed (the server rolls back and releases the lock) and
  the call fails with `TransactionLeftOpenError` (the work's own failure, if any, is in `cause`). One extra
  query per call. **(breaking)**
- A server-side session break during `withSessionAdvisoryLock` work is `AdvisoryLockLostError` (a subclass of
  `TransactionConnectionLostError`, stage `work`), not a silent success: the server had released the lock and
  another session could take it before the work returned. **(breaking)**
- A manual `COMMIT`/`ROLLBACK` inside the work followed by a failure is `ManualTransactionControlError` (the
  work's failure in `cause`) and is never retried — previously each retry re-ran the work after a partial
  commit. **(breaking)**
- `connection-before-work` retries no longer repeat what a retry cannot fix: programming errors (`TypeError`,
  `RangeError`, `ReferenceError` in the chain) and connection refusals of class 28 (password, role, pg_hba) and
  3D000 (no database). 53300 and 57P03 are still retried.
- A throwing `retry.when` or `wrapFailure` callback yields `TransactionCallbackError` (`callback`,
  `callbackError`, original failure in `cause`); `attemptFailed` is still reported, no retry. **(breaking)**
- A query of a rolled-back savepoint that outlived it (timer, forgotten `await`) is
  `TransactionClientMisuseError` instead of a write into the outer transaction; both paths (raw client and the
  savepoint's `tx.execute`) are closed, including a `client.query` reference taken in advance.
- The work cannot remove the package's connection listeners: `removeAllListeners`/`off`/`removeListener`
  through the work's client remove only listeners added through it. Listeners the work added and did not
  remove are removed when the work ends (transaction, savepoint, session lock).
- `withTenant` requires a transaction: type `SqlExecutor & TransactionHandle` and a runtime `rollback` check.
  A tenant id, `localSettings` values and string lock keys containing NUL or a lone surrogate are a
  `RangeError` before any query (the driver used to replace lone surrogates with U+FFFD, so two different
  tenants or keys could collide). **(breaking)**
- A `null`/`undefined` database in every entry point is a clear "the database must be over a pg pool" error,
  not a `TypeError`.
- Error messages are built without throwing on values without a prototype, throwing `Symbol.toPrimitive` or
  `message` getters; `toError` keeps the original value in `cause`.
- `$…$` quote detection is linear (7 500 quoted strings used to cost ×70 the time of 750).

### Documented limits

- The pool's `query_timeout` is mandatory: BEGIN and COMMIT have no ceiling of their own.
- `COMMIT; BEGIN` inside the work is not detected.

### Migration

- `withSessionAdvisoryLock` work must close its own transactions (`COMMIT`/`ROLLBACK` in `finally`); handle
  `TransactionLeftOpenError` and `AdvisoryLockLostError` (or `TransactionConnectionLostError`).
- Do not control the transaction inside the work: `ManualTransactionControlError` is never retried.
- Call `withTenant` only with the work's `tx`, not with the root `db`.
- Do not pass NUL or lone surrogates in tenant ids, `localSettings` and lock keys.
- A failure of your `retry.when`/`wrapFailure` now arrives as `TransactionCallbackError.callbackError`.
- Set `query_timeout` on the pool.

## [0.8.0] - 2026-11-17

Second external audit: every claim was re-checked by an executable probe; true claims fixed, false ones pinned
by tests.

### Fixed

- Advisory-lock polling (`pg_try_*`) honours `timeoutMs` and `signal`; on a frozen network the connection is
  destroyed instead of hanging until the OS TCP timeout. `pg_advisory_unlock` has a 5 s ceiling.
- `withSessionAdvisoryLock` guards the work's client like a transaction does: `release()` and `end()` are
  `TransactionClientMisuseError`. **(breaking)**
- `withSessionAdvisoryLock` inside the work of a transaction on the same pool is `NestedTransactionError`
  (it would wait for a second connection while the transaction holds the first). **(breaking)**
- `client.end()` inside transaction work is `TransactionClientMisuseError` (`CLIENT_MISUSE.end`); the
  transaction is rolled back on a healthy connection.
- `retry.on: ['lock-timeout']` also retries `AdvisoryLockTimeoutError` of `withAdvisoryLock` (it now carries
  `code = '55P03'`).
- `$…$` strings are data except where Postgres executes them (`DO`, function bodies, `EXECUTE` in PL/pgSQL);
  inside executable bodies a statement also starts after `BEGIN`/`THEN`/`ELSE`/`LOOP`.
- `assertPoolerCompatible` reads startup parameters with pg's own code: host-less connection strings,
  `PGOPTIONS` and `pg.defaults` are now checked. **(breaking)**
- `localSettings` with the same parameter spelled in two cases is refused. **(breaking)**
- `withTenant` accepts multi-part parameter names (`app.context.tenant_id`).
- A baseline that `resetSession` cannot restore fails at stage `work` (ROLLBACK, healthy connection) instead of
  being treated as a BEGIN failure.
- Under a savepoint, `transactionPooler: true` without it on the outer transaction is refused.
- `withSessionAdvisoryLock` accepts a pg `Pool` as well as drizzle over it.
- `retryDelayMs` no longer returns `NaN` for attempt ≥ 1025; a late `release()` after a cancelled pool wait no
  longer causes an unhandled rejection.

### Migration

Do not call `client.release()`/`client.end()` from `withSessionAdvisoryLock` work; do not call it inside a
transaction of the same pool; remove `PGOPTIONS`/`pg.defaults.*_timeout` behind a transaction pooler; do not
spell one parameter twice in `localSettings`.

## [0.7.2] - 2026-11-17

### Fixed

- Declarations for ESM consumers: the build emits a `.d.mts` next to each `.d.ts`, and `exports` serves
  `.d.mts` under `import` and `.d.ts` under `require` (same JS). ESM consumers used to get TS2345 on
  `withTenant(tx)` with their own `db.transaction`.
- The consumer matrix gained `nodenext-esm`, latest drizzle-orm/pg and TypeScript 7 cases.

## [0.7.1] - 2026-11-17

### Added

- `resetAppSettings: string[]`: the package itself resets the listed custom parameters (`prefix.name`) to the
  session default after the work and before COMMIT (`set_config(name, NULL, false)`, only for parameters
  present in the session). Meant for wrapper libraries whose own parameter could be left session-wide by user
  work under a transaction pooler.

## [0.7.0] - 2026-11-16

### Changed

- **(breaking)** `transactionPooler: true` is stricter. Refused before sending: temporary objects that outlive
  the transaction, `set_config` whose `is_local` is not proven `true` (literal or parameter **value**),
  statements hidden behind comments inside strings, `DEALLOCATE`, `LOAD`, `pg_advisory_unlock_all()`,
  `dblink_connect`, `pg_replication_origin_session_setup`. Unparseable text is refused.
- New second line of defence: the server connection state is snapshotted in the same message as BEGIN and as
  COMMIT/ROLLBACK; a difference is `SessionStateLeakError` (`changes`, `committed`, `verified`, `probeError`,
  kinds in `SESSION_STATE_KIND`). `sessionStateCheck: false` turns it off.
- `withSessionAdvisoryLock` with `transactionPooler: true` is refused.
- **(breaking)** `resetSession: true` restores the state after `pool.on('connect')` (`sessionBaseline:
  'connect'`, default) instead of session defaults; `'defaults'` keeps the old behaviour. Temporary objects,
  WITH HOLD cursors or session locks present after connect fail the first such transaction. The `role`
  snapshot column now has two items (`current_user = …`, `session_user = …`).

### Migration

Rewrite refused statements to transaction-scoped forms (`ON COMMIT DROP`, `SET LOCAL`,
`set_config(…, true)`, `pg_advisory_xact_lock`); use the `isolationLevel` option instead of
`SET TRANSACTION ISOLATION LEVEL` as the first statement; treat `SessionStateLeakError` as a programming error
(with `committed: true` do not retry). Use `sessionBaseline: 'defaults'` for the old cleanup.

## [0.6.1] - 2026-11-15

### Changed

- `TIMER_LIMIT` moved to its own module; the root export is unchanged.

## [0.6.0] - 2026-11-15

### Added

- `TransactionConnectionLostError`: a server-side session break no longer crashes the process with an
  unhandled `'error'` event.
- `CommitOutcomeUnknownError` for a connection lost after COMMIT was sent; never retried.
- `NestedTransactionError` for a nested call on the same pool (it used to deadlock the pool);
  `nested: NESTED_TRANSACTION.savepoint` for a savepoint instead.
- `rollbackTimeoutMs` (default 5 s), `TransactionRetryAbortedError`, `retry.on` (`RETRY_REASON`) and
  `retry.when`, `withTenant` and `localSettings`, `withAdvisoryLock` and `withSessionAdvisoryLock`,
  `observer` and `poolStats`, `resetSession` and `transactionPooler`.

### Migration

Catch `TransactionRetryAbortedError` (with `reason === signal.reason`) instead of comparing to
`signal.reason`; treat `CommitOutcomeUnknownError` as "maybe committed"; move independent transactions out of
the work or use `nested: savepoint`; handle `TransactionConnectionLostError`.

## [0.5.0] - 2026-11-15

### Changed

- **(breaking)** The default transaction type comes from the consumer's database (`TransactionOf<Db>`),
  `PlainTransaction` is removed; type parameters are `<T, Db, Tx>`.
- Consumer matrix (`pnpm run test:consumers`), `exports` map gate, deep-frozen exported dictionaries.

### Migration

Replace `PlainTransaction` with `TransactionOf<typeof db>`. Annotated work is unchanged.

## [0.4.1] - 2026-11-15

### Changed

- Transaction timeouts are sent in one query instead of one per setting.

## [0.4.0] - 2026-11-15

### Changed

- Retries on 40001/40P01 without `backoffMs` wait (base 25 ms, ×2 per attempt, full jitter) instead of
  retrying immediately. An explicit `backoffMs: 0` still means no pause.

## [0.3.3] - 2026-11-15

### Fixed

- The guarded client exposes own instance properties unbound, so `jest.spyOn(client, 'query')` works.

## [0.3.2] - 2026-11-14

### Fixed

- `tx.*` is guarded like the raw client: a query through `tx` after the work returned is
  `TransactionClientMisuseError` instead of an autocommit outside the transaction.

## [0.3.0] - 2026-11-14

### Changed

- The transaction inherits the database's dialect (`casing`), schema (`tx.query.*`), logger and cache, like
  `db.transaction`.
- `client.release()` inside the work and `client.query` after the end are `TransactionClientMisuseError`.
- `signal` cancels before connecting, while waiting for a pool connection and between retries.

### Migration

Transaction queries now go through the database logger and cache; `release()` from the work throws.

## [0.2.0] - 2026-11-14

### Added

- Transaction options: `isolationLevel`, `readOnly`, `deferrable`, `lockTimeoutMs`, `statementTimeoutMs`,
  `idleInTransactionTimeoutMs` (transaction-scoped `set_config`), `retry` on 40001/40P01,
  `ManualTransactionControlError`, pool detection by shape instead of `instanceof`.

## [0.1.0] – [0.1.4] - 2026-11-10

### Added

- `transactionKeepingFailure`: BEGIN inside `try`, the original failure is rethrown, a connection whose
  rollback failed is destroyed, COMMIT answered with ROLLBACK is `CommitRolledBackError`; structural types
  (`PoolDatabase`, `TransactionHandle`, 0.1.2); the transaction's `PoolClient` as the second argument of the
  work (0.1.4).
