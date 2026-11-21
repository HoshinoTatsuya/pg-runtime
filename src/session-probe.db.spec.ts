import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import { SESSION_PROBE_SQL } from './constants/session-probe.constant';
import { SESSION_STATE_KIND } from './constants/session-state-kind.constant';
import { sessionStateChanges } from './session-state-changes';
import { sessionStateOf } from './session-state-of';
import { createTestDatabase } from './testing/test-database';
import type { SessionStateKind } from './types/session-state-kind.type';

const adminUrl = process.env.PG_TEST_URL;
const describeDb = adminUrl ? describe : describe.skip;

jest.setTimeout(30_000);

/**
 * Сверка состояния серверного соединения (`SESSION_PROBE_SQL`) по классу: КАЖДАЯ
 * форма сессионного состояния, переживающего транзакцию, видна разницей
 * снимков «BEGIN; сверка» и «COMMIT; сверка»; законные двойники (на транзакцию)
 * разницы не дают. Прямо в Postgres: сверка не зависит от пулера.
 */
describeDb('сверка состояния серверного соединения [нужен PG_TEST_URL]', () => {
  const role = `probe_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let database: { url: string; drop(): Promise<void> };

  beforeAll(async () => {
    database = await createTestDatabase(adminUrl as string, [`CREATE ROLE ${role} NOLOGIN`]);
  });
  afterAll(async () => {
    await database?.drop();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  /** Виды изменений, которые оставил `statement`, выполненный в транзакции на свежем соединении. */
  const changedKinds = async (
    statement: string,
    begin = 'BEGIN',
    end = 'COMMIT',
  ): Promise<SessionStateKind[]> => {
    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      const opened = (await client.query(`${begin}; ${SESSION_PROBE_SQL}`)) as unknown as Array<{
        rows: unknown[];
      }>;
      await client.query(statement.replaceAll('<role>', role));
      const closed = (await client.query(`${end}; ${SESSION_PROBE_SQL}`)) as unknown as Array<{
        rows: unknown[];
      }>;
      const changes = sessionStateChanges(
        sessionStateOf(opened[1]?.rows[0]),
        sessionStateOf(closed[1]?.rows[0]),
      );
      return [...new Set(changes.map(({ kind }) => kind))];
    } finally {
      await client.end();
    }
  };

  it.each([
    ['SET search_path = leaked', SESSION_STATE_KIND.setting],
    ['SET SESSION statement_timeout = 1234', SESSION_STATE_KIND.setting],
    ["SELECT set_config('work_mem', '7MB', false)", SESSION_STATE_KIND.setting],
    ['SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE', SESSION_STATE_KIND.setting],
    ['SET ROLE <role>', SESSION_STATE_KIND.role],
    ['SET SESSION AUTHORIZATION <role>', SESSION_STATE_KIND.role],
    ['CREATE TEMP TABLE leak_t (x int)', SESSION_STATE_KIND.temporaryObject],
    ['CREATE TEMP TABLE leak_t (x int) ON COMMIT DELETE ROWS', SESSION_STATE_KIND.temporaryObject],
    ['CREATE TEMP SEQUENCE leak_s', SESSION_STATE_KIND.temporaryObject],
    ['CREATE TEMP VIEW leak_v AS SELECT 1', SESSION_STATE_KIND.temporaryObject],
    [
      'CREATE FUNCTION pg_temp.leak_f() RETURNS int LANGUAGE sql AS $$SELECT 1$$',
      SESSION_STATE_KIND.temporaryObject,
    ],
    ['SELECT 1 AS x INTO TEMP leak_t', SESSION_STATE_KIND.temporaryObject],
    ['DECLARE leak_c CURSOR WITH HOLD FOR SELECT 1', SESSION_STATE_KIND.holdableCursor],
    ['PREPARE leak_p AS SELECT 1', SESSION_STATE_KIND.preparedStatement],
    ['LISTEN leak_channel', SESSION_STATE_KIND.listenChannel],
    ['SELECT pg_advisory_lock(4242)', SESSION_STATE_KIND.advisoryLock],
    ['SELECT pg_advisory_lock_shared(4243)', SESSION_STATE_KIND.advisoryLock],
    ['SELECT pg_try_advisory_lock(1, 2)', SESSION_STATE_KIND.advisoryLock],
  ])('форма видна: %s → %s', async (statement, kind) => {
    expect(await changedKinds(statement)).toEqual([kind]);
  });

  it.each([
    "SET LOCAL search_path = 'x'",
    "SELECT set_config('app.custom', 'v', true)",
    'SET TRANSACTION READ ONLY',
    'CREATE TEMP TABLE ok_t (x serial PRIMARY KEY) ON COMMIT DROP',
    'CREATE TABLE pg_temp.ok_t (x int) ON COMMIT DROP',
    'SELECT pg_advisory_xact_lock(4242)',
    'SELECT pg_advisory_xact_lock_shared(4243)',
    'DECLARE ok_c CURSOR FOR SELECT 1',
  ])('законный двойник разницы не даёт: %s', async (statement) => {
    expect(await changedKinds(statement)).toEqual([]);
  });

  it('ограничение (названо в README): свой параметр (app.*) сверке не виден — Postgres не показывает такие параметры ни в pg_settings, ни в SHOW ALL; его ловит только текст', async () => {
    expect(await changedKinds("SET app.custom = 'v'")).toEqual([]);
    expect(await changedKinds("SELECT set_config('app.custom', 'v', false)")).toEqual([]);
  });

  it('параметры самой транзакции (BEGIN ISOLATION LEVEL …, READ ONLY, DEFERRABLE) разницы не дают', async () => {
    expect(await changedKinds('SELECT 1', 'BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE')).toEqual(
      [],
    );
  });

  it('после ROLLBACK остаются только нетранзакционные формы: сессионный лок и PREPARE видны, SET и TEMP — нет', async () => {
    expect(
      await changedKinds(
        'SET search_path = x; CREATE TEMP TABLE r_t (x int); PREPARE r_p AS SELECT 1; SELECT pg_advisory_lock(9)',
        'BEGIN',
        'ROLLBACK',
      ),
    ).toEqual([SESSION_STATE_KIND.preparedStatement, SESSION_STATE_KIND.advisoryLock]);
  });

  it('снятое чужое тоже изменение: UNLISTEN * и pg_advisory_unlock_all() того, что было до транзакции', async () => {
    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      await client.query('LISTEN earlier; SELECT pg_advisory_lock(5)');
      const opened = (await client.query(`BEGIN; ${SESSION_PROBE_SQL}`)) as unknown as Array<{
        rows: unknown[];
      }>;
      await client.query('UNLISTEN *; SELECT pg_advisory_unlock_all()');
      const closed = (await client.query(`COMMIT; ${SESSION_PROBE_SQL}`)) as unknown as Array<{
        rows: unknown[];
      }>;
      expect(
        sessionStateChanges(sessionStateOf(opened[1]?.rows[0]), sessionStateOf(closed[1]?.rows[0])).map(
          ({ kind, change }) => [kind, change],
        ),
      ).toEqual([
        [SESSION_STATE_KIND.listenChannel, 'disappeared'],
        [SESSION_STATE_KIND.advisoryLock, 'disappeared'],
      ]);
    } finally {
      await client.end();
    }
  });

  it('строка сверки без колонки — отказ, а не «ничего не изменилось»', () => {
    expect(() => sessionStateOf({ setting: [] })).toThrow('не прочитана');
    expect(() => sessionStateOf(undefined)).toThrow('не прочитана');
  });
});
