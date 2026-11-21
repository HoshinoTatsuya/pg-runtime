import { Pool, defaults as pgDefaults } from 'pg';

import { advisoryLockKeySql } from './advisory-lock-key-sql';
import { assertPoolerCompatible } from './assert-pooler-compatible';
import { APP_SETTINGS_RESET_SQL } from './constants/app-settings-reset.constant';
import { PoolerIncompatibleError } from './pooler-incompatible.error';
import { poolerViolations } from './pooler-violations';

describe('совместимость с пулером в transaction mode', () => {
  it.each([
    "SET application_name = 'x'",
    'set search_path to public',
    'SET SESSION work_mem = 1',
    '-- комментарий\nSET x.y = 1',
    'RESET ALL',
    'LISTEN ch',
    'UNLISTEN *',
    'PREPARE p AS SELECT 1',
    'DECLARE c CURSOR WITH HOLD FOR SELECT 1',
    'DISCARD ALL',
    'SELECT pg_advisory_lock(1)',
    'SELECT pg_try_advisory_lock(1)',
    'SELECT pg_advisory_unlock(1)',
    'SELECT pg_advisory_lock_shared(1)',
    "SELECT set_config('a.b', '1', false)",
    'SELECT 1; SET work_mem = 1',
  ])('отказ: %s', (text) => {
    expect(poolerViolations(text).length).toBeGreaterThan(0);
  });

  it.each([
    "SET LOCAL application_name = 'x'",
    'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
    'SET CONSTRAINTS ALL DEFERRED',
    'SELECT pg_advisory_xact_lock(1)',
    'SELECT pg_try_advisory_xact_lock(1)',
    "SELECT set_config('a.b', '1', true)",
    "SELECT 'SET x = 1' AS text",
    'DECLARE c CURSOR FOR SELECT 1',
    'INSERT INTO settings (name) VALUES ($1)',
  ])('допустимо: %s', (text) => {
    expect(poolerViolations(text)).toEqual([]);
  });

  // Сессионное состояние, переживающее транзакцию, — по классу: временные
  // объекты без ON COMMIT DROP, set_config с недоказанным is_local, формы,
  // которые прежний разбор пропускал (комментарий внутри строки), прочие
  // сессионные операторы и функции.
  it.each([
    'CREATE TEMP TABLE leak_t (x int)',
    'create temporary table leak_t as select 1 as x',
    'CREATE LOCAL TEMP TABLE leak_t (x int) ON COMMIT DELETE ROWS',
    'CREATE GLOBAL TEMPORARY TABLE leak_t (x int) ON COMMIT PRESERVE ROWS',
    'CREATE TEMP TABLE IF NOT EXISTS leak_t (x int)',
    'CREATE TEMP SEQUENCE leak_s',
    'CREATE TEMP VIEW leak_v AS SELECT 1',
    'CREATE OR REPLACE TEMPORARY VIEW leak_v AS SELECT 1',
    'CREATE TEMP RECURSIVE VIEW leak_v (n) AS SELECT 1',
    'CREATE TABLE pg_temp.leak_t (x int)',
    'CREATE VIEW pg_temp.leak_v AS SELECT 1',
    'CREATE SEQUENCE pg_temp.leak_s',
    'CREATE FUNCTION pg_temp.leak_f() RETURNS int LANGUAGE sql AS $$SELECT 1$$',
    'SELECT 1 AS x INTO TEMP leak_t',
    'SELECT * INTO TEMPORARY TABLE leak_t FROM pg_class',
    'WITH a AS (SELECT 1 AS x) SELECT * INTO LOCAL TEMP leak_t FROM a',
    'SELECT 1 AS x INTO pg_temp.leak_t',
    'SELECT 1; CREATE TEMP TABLE leak_t (x int)',
    "SELECT set_config('a.b', '1', 'f')",
    "SELECT set_config('a.b', '1', NOT true)",
    "SELECT set_config('a.b', '1', (false))",
    "SELECT set_config('a.b', '1', 0::boolean)",
    "SELECT pg_catalog.set_config('a.b', '1', false)",
    `SELECT "set_config"('a.b', '1', false)`,
    "SELECT set_config('a.b', concat('x', ')'), false)",
    "SELECT set_config('a.b', '1')",
    'SELECT set_config($1, $2, $3)',
    "SELECT '--'; SET work_mem = 1",
    "SELECT '/*'; SET work_mem = 1; SELECT '*/'",
    'SELECT $$--$$; SET work_mem = 1',
    "SELECT E'\\''; SET work_mem = 1",
    'DO $$BEGIN PERFORM pg_advisory_lock(1); END$$',
    "LOAD 'auto_explain'",
    'DEALLOCATE ALL',
    'SELECT pg_advisory_unlock_all()',
    'SELECT "pg_advisory_lock"(1)',
    "SELECT dblink_connect('c', 'dbname=x')",
    "SELECT pg_replication_origin_session_setup('o')",
    "SELECT 'незакрытая",
    'SELECT $$незакрытая',
    'SELECT 1 /* незакрытый',
  ])('отказ (класс сессионного состояния): %s', (text) => {
    expect(poolerViolations(text).length).toBeGreaterThan(0);
  });

  it.each([
    'CREATE TEMP TABLE t (x int) ON COMMIT DROP',
    'CREATE TEMPORARY TABLE t ON COMMIT DROP AS SELECT 1 AS x',
    'create local temp table if not exists t (x int) on commit drop',
    'CREATE TABLE pg_temp.t (x int) ON COMMIT DROP',
    'CREATE TABLE public.copy AS SELECT * FROM pg_temp.t',
    'INSERT INTO temp VALUES (1)',
    'MERGE INTO temp USING src ON true WHEN MATCHED THEN DO NOTHING',
    "SELECT set_config('a.b', '1', TRUE)",
    "SELECT set_config('a.b', $1, true::boolean)",
    "SELECT pg_catalog.set_config('a.b', concat('x', ')', ','), true)",
    "SELECT 'SET x = 1; LISTEN y; CREATE TEMP TABLE z (x int)' AS text",
    "SELECT $$it's$$ AS literal",
    "SELECT E'\\'; SET x = 1' AS escaped",
    'SELECT "set config" FROM t',
    'UPDATE t SET a = 1',
    '-- SET x = 1\nSELECT 1',
    'DECLARE c CURSOR WITHOUT HOLD FOR SELECT 1',
    'SELECT pg_advisory_xact_lock_shared(1)',
  ])('допустимо (законный двойник): %s', (text) => {
    expect(poolerViolations(text)).toEqual([]);
  });

  // $-кавычки: строка там, где Postgres её не исполняет, и код — в DO, теле
  // функции и EXECUTE PL/pgSQL (в том числе после BEGIN/THEN/ELSE/LOOP).
  it.each([
    'SELECT $q$SET x = 1$q$',
    'INSERT INTO posts (body) VALUES ($$RESET everything$$)',
    'SELECT $$LISTEN x$$, $t$DISCARD ALL$t$ AS b',
    'COMMENT ON TABLE posts IS $$SET work_mem = 1$$',
    "UPDATE posts SET body = $b$PREPARE p AS SELECT 1; LOAD 'x'$b$ WHERE id = 1",
  ])('допустимо ($-строка — данные, а не код): %s', (text) => {
    expect(poolerViolations(text)).toEqual([]);
  });

  it.each([
    'DO $$BEGIN SET work_mem = 1; END$$',
    'DO LANGUAGE plpgsql $$BEGIN RESET ALL; END$$',
    'DO $$ BEGIN IF true THEN LISTEN ch; END IF; END $$ LANGUAGE plpgsql',
    'DO $$BEGIN IF false THEN NULL; ELSE DISCARD ALL; END IF; END$$',
    'DO $$BEGIN LOOP UNLISTEN *; EXIT; END LOOP; END$$',
    'DO $$BEGIN EXECUTE $e$SET work_mem = 1$e$; END$$',
    'CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $f$SET work_mem = 1$f$',
    'CREATE OR REPLACE PROCEDURE p() LANGUAGE plpgsql AS $$BEGIN RESET ALL; END$$',
  ])('отказ ($-кавычка — исполняемый код): %s', (text) => {
    expect(poolerViolations(text).length).toBeGreaterThan(0);
  });

  it('set_config с именованным is_local — отказ фильтра; сервер такую запись тоже отвергает (42883, у set_config нет имён аргументов)', () => {
    expect(poolerViolations("SELECT set_config('a.b', '1', is_local => true)")).toHaveLength(1);
    expect(poolerViolations("SELECT set_config('a.b', '1', is_local := true)")).toHaveLength(1);
  });

  it('set_config($n): решает ЗНАЧЕНИЕ параметра — из второго аргумента query или из values конфигурации', () => {
    const text = 'SELECT set_config($1, $2, $3)';
    // Второй аргумент — как его передаёт guardedClient (args[1] у client.query).
    const check = poolerViolations as (query: unknown, values?: unknown) => string[];
    for (const local of [true, 'true', 't', ' ON ', 'yes', 'y', '1']) {
      expect([local, check(text, ['a.b', 'v', local])]).toEqual([local, []]);
      expect([local, poolerViolations({ text, values: ['a.b', 'v', local] })]).toEqual([local, []]);
    }
    for (const session of [false, 'false', 'f', 'off', '0', 'tr', null, undefined, 1]) {
      expect([session, check(text, ['a.b', 'v', session]).length]).toEqual([session, 1]);
      expect([session, poolerViolations({ text, values: ['a.b', 'v', session] }).length]).toEqual([
        session,
        1,
      ]);
    }
    // Параметров нет вовсе — не доказано.
    expect(check(text)).toHaveLength(1);
    // Второй аргумент query важнее values конфигурации (так pg и шлёт).
    expect(check({ text, values: ['a.b', 'v', true] }, ['a.b', 'v', false])).toHaveLength(1);
    expect(check('SELECT set_config($2, $3, $1)', [true, 'a.b', 'v'])).toEqual([]);
  });

  it('именованный подготовленный оператор — отказ; без имени — нет', () => {
    expect(poolerViolations({ name: 'q1', text: 'SELECT 1' })).toHaveLength(1);
    expect(poolerViolations({ text: 'SELECT 1' })).toEqual([]);
    expect(poolerViolations({ name: '', text: 'SELECT 1' })).toEqual([]);
  });

  it('assertPoolerCompatible: параметры старта сессии в пуле и строке подключения — отказ со списком', () => {
    const pools = [
      new Pool({ statement_timeout: 1000 }),
      new Pool({ connectionString: 'postgres://u@h/db?options=-c%20lock_timeout%3D1s' }),
      new Pool({ connectionString: 'postgres://u@h/db?application_name=svc' }),
      new Pool({ idle_in_transaction_session_timeout: 5000, lock_timeout: 100 }),
    ];
    try {
      const problems = pools.map((pool) => {
        try {
          assertPoolerCompatible(pool);
          return [];
        } catch (error) {
          expect(error).toBeInstanceOf(PoolerIncompatibleError);
          return (error as PoolerIncompatibleError).problems;
        }
      });
      expect(problems[0]).toEqual(['параметр пула statement_timeout уходит параметром старта сессии']);
      expect(problems[1]).toEqual(['параметр options в строке подключения уходит параметром старта сессии']);
      expect(problems[2]).toEqual([]);
      expect(problems[3]).toHaveLength(2);
      expect(() => assertPoolerCompatible({ $client: pools[2] })).not.toThrow();
      expect(() => assertPoolerCompatible({ $client: {} })).toThrow('ожидается пул pg');
    } finally {
      for (const pool of pools) {
        void pool.end();
      }
    }
  });

  it('assertPoolerCompatible: параметры старта — там же, где их берёт pg: строка без хоста, PGOPTIONS, pg.defaults', () => {
    const problemsOf = (pool: Pool): readonly string[] => {
      try {
        assertPoolerCompatible(pool);
        return [];
      } catch (error) {
        expect(error).toBeInstanceOf(PoolerIncompatibleError);
        return (error as PoolerIncompatibleError).problems;
      }
    };
    const pools: Pool[] = [];
    const pool = (config: ConstructorParameters<typeof Pool>[0]): Pool => {
      const created = new Pool(config);
      pools.push(created);
      return created;
    };
    const savedOptions = process.env.PGOPTIONS;
    const savedDefault = pgDefaults.statement_timeout;
    try {
      // Строка без хоста (сокет в host=…): pg её разбирает, new URL — нет.
      expect(
        problemsOf(
          pool({
            connectionString: 'postgres://u@/db?host=/var/run/postgresql&options=-c%20lock_timeout%3D1s',
          }),
        ),
      ).toEqual(['параметр options в строке подключения уходит параметром старта сессии']);
      delete process.env.PGOPTIONS;
      const clean = pool({ connectionString: 'postgres://u@h/db' });
      expect(problemsOf(clean)).toEqual([]);
      process.env.PGOPTIONS = '-c statement_timeout=5000';
      expect(problemsOf(clean)).toEqual([
        'параметр options приходит из окружения процесса (PGOPTIONS) или pg.defaults и уходит параметром старта сессии',
      ]);
      delete process.env.PGOPTIONS;
      (pgDefaults as { statement_timeout: unknown }).statement_timeout = 5000;
      expect(problemsOf(clean)).toEqual([
        'параметр statement_timeout приходит из pg.defaults и уходит параметром старта сессии',
      ]);
    } finally {
      (pgDefaults as { statement_timeout: unknown }).statement_timeout = savedDefault;
      if (savedOptions === undefined) {
        delete process.env.PGOPTIONS;
      } else {
        process.env.PGOPTIONS = savedOptions;
      }
      for (const created of pools) {
        void created.end();
      }
    }
  });

  it('сброс resetAppSettings — запрос самого пакета; из работы тот же текст с теми же значениями — отказ фильтра', () => {
    expect(poolerViolations(APP_SETTINGS_RESET_SQL, [['lib.marker']])).toEqual([
      'set_config(…, false): is_local не литерал true — параметр сессии',
    ]);
  });

  it('ключ advisory-лока: строка — 64-битный хэш, целое — само, вне int8 и дробное — отказ', () => {
    expect(advisoryLockKeySql('job')).toEqual({
      expression: 'hashtextextended($1::text, 0)',
      value: 'job',
      label: '«job»',
    });
    expect(advisoryLockKeySql(42).value).toBe('42');
    expect(advisoryLockKeySql(-(2n ** 63n)).value).toBe('-9223372036854775808');
    expect(advisoryLockKeySql(2n ** 63n - 1n).value).toBe('9223372036854775807');
    expect(() => advisoryLockKeySql(2n ** 63n)).toThrow('вне int8');
    expect(() => advisoryLockKeySql(-(2n ** 63n) - 1n)).toThrow('вне int8');
    expect(() => advisoryLockKeySql(Number.MAX_SAFE_INTEGER + 1)).toThrow('безопасное целое');
    expect(() => advisoryLockKeySql(' job')).toThrow('пробелами по краям');
    expect(() => advisoryLockKeySql({} as never)).toThrow('строка, число или bigint');
  });
});
