import type { SQL } from 'drizzle-orm';
import { Client, type Pool, type PoolClient } from 'pg';

import { advisoryLockKeySql } from './advisory-lock-key-sql';
import { AdvisoryLockTimeoutError } from './advisory-lock-timeout.error';
import { assertPoolerCompatible } from './assert-pooler-compatible';
import { codeTail } from './code-tail';
import { CommitOutcomeUnknownError } from './commit-outcome-unknown.error';
import { connectAbortable } from './connect-abortable';
import { RETRY_REASON } from './constants/retry-reason.constant';
import { SQL_LEXEME } from './constants/sql-lexeme.constant';
import { TRANSACTION_STAGE } from './constants/transaction-stage.constant';
import { errorChain } from './error-chain';
import { isRetryable } from './is-retryable';
import { localSettings } from './local-settings';
import { poolStats } from './pool-stats';
import { resolveRetry } from './resolve-retry';
import { safeText } from './safe-text';
import { sqlCode } from './sql-code';
import { toError } from './to-error';
import { TransactionCallbackError } from './transaction-callback.error';
import { TransactionConnectionLostError } from './transaction-connection-lost.error';
import { transactionKeepingFailure } from './transaction-keeping-failure';
import { TransactionLeftOpenError } from './transaction-left-open.error';
import { TransactionRetryAbortedError } from './transaction-retry-aborted.error';
import { withAdvisoryLock } from './with-advisory-lock';
import { withSessionAdvisoryLock } from './with-session-advisory-lock';
import { withTenant } from './with-tenant';

const rollbackNever = (): never => {
  throw new Error('rollback');
};

/** Проверки опций и классификации без базы: каждая — на форме, которую аудит назвал. */
describe('опции и классификация отказов', () => {
  it('localSettings: один параметр Postgres под двумя написаниями — отказ (имена без учёта регистра)', () => {
    expect(() => localSettings({ lockTimeoutMs: 5, localSettings: { LOCK_TIMEOUT: '1s' } })).toThrow(
      'задан и опцией таймаута или другим своим параметром (lock_timeout;',
    );
    expect(() => localSettings({ localSettings: { 'app.X': '1', 'app.x': '2' } })).toThrow(
      'задан и опцией таймаута или другим своим параметром (app.X;',
    );
    // Двойник: разные параметры проходят.
    expect(localSettings({ lockTimeoutMs: 5, localSettings: { 'app.x': '1', 'app.y': '2' } })).toEqual([
      ['lock_timeout', '5ms'],
      ['app.x', '1'],
      ['app.y', '2'],
    ]);
  });

  it('withTenant: параметр из нескольких частей (app.context.tenant_id) принимается, без точки и с пустой частью — отказ', async () => {
    const sent: SQL[] = [];
    const tx = { execute: async (query: SQL) => sent.push(query), rollback: rollbackNever };
    await withTenant(tx, 't1', 'app.context.tenant_id');
    await withTenant(tx, 't1', 'app.tenant_id');
    expect(sent).toHaveLength(2);
    for (const bad of ['tenant_id', 'app..tenant', 'app.', '.app', 'app.1x', 'app.x y']) {
      await expect(withTenant(tx, 't1', bad)).rejects.toThrow('вида префикс.имя');
    }
    expect(sent).toHaveLength(2);
  });

  it("AdvisoryLockTimeoutError — 55P03: retry.on ['lock-timeout'] повторяет, по умолчанию — нет", () => {
    const timeout = new AdvisoryLockTimeoutError('«job»', 100);
    expect(timeout.code).toBe('55P03');
    const lockTimeout = resolveRetry({ attempts: 2, on: [RETRY_REASON.lockTimeout] });
    expect(isRetryable(timeout, TRANSACTION_STAGE.work, lockTimeout)).toBe(true);
    expect(isRetryable(new Error('wrapped', { cause: timeout }), TRANSACTION_STAGE.work, lockTimeout)).toBe(
      true,
    );
    expect(isRetryable(timeout, TRANSACTION_STAGE.work, resolveRetry({ attempts: 2 }))).toBe(false);
  });

  it('connectAbortable: соединение пришло после отмены, а его возврат упал — без unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      let deliver: (client: PoolClient) => void = () => undefined;
      const pool = {
        connect: () =>
          new Promise<PoolClient>((resolve) => {
            deliver = resolve;
          }),
      } as unknown as Pool;
      const controller = new AbortController();
      const pending = connectAbortable(pool, controller.signal);
      controller.abort(new Error('отмена'));
      await expect(pending).rejects.toThrow('отмена');
      let released = 0;
      deliver({
        release: () => {
          released += 1;
          throw new Error('release called on already released client');
        },
      } as unknown as PoolClient);
      // Два оборота цикла: возврат позднего соединения и разбор необработанных отказов.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect([released, unhandled]).toEqual([1, []]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('errorChain — не глубже пяти звеньев: цикл не вешает разбор, цепочка обёрток 2–3 звена укладывается', () => {
    const looped = new Error('цикл') as Error & { cause?: unknown };
    looped.cause = looped;
    expect(errorChain(looped)).toHaveLength(5);
    const server = Object.assign(new Error('deadlock'), { code: '40P01' });
    const drizzleError = new Error('Failed query', { cause: server });
    expect(errorChain(new Error('wrapFailure', { cause: drizzleError }))).toEqual([
      expect.any(Error),
      drizzleError,
      server,
    ]);
  });

  it('строку «ключ=значение» pg не разбирает как параметры: statement_timeout из неё не уходит серверу', () => {
    const client = new Client({ connectionString: 'host=localhost statement_timeout=5000 dbname=x' });
    const startup = (client as unknown as { getStartupConf(): Record<string, unknown> }).getStartupConf();
    expect(startup.statement_timeout).toBeUndefined();
    expect(startup.database).toBe('host=localhost statement_timeout=5000 dbname=x');
    // Контроль: та же настройка URL-строкой уходит.
    const url = new Client({ connectionString: 'postgres://u@h/db?statement_timeout=5000' });
    expect(
      (url as unknown as { getStartupConf(): Record<string, unknown> }).getStartupConf().statement_timeout,
    ).toBe('5000');
  });

  it('withTenant: корневой клиент (без rollback) — отказ до запроса: контекст на транзакцию ему не задать', async () => {
    const sent: SQL[] = [];
    const root = { execute: async (query: SQL) => sent.push(query) };
    await expect(withTenant(root as never, 't1')).rejects.toThrow('withTenant: нужна транзакция');
    expect(sent).toEqual([]);
  });

  it.each([
    ['NUL', 't\u00001'],
    ['непарный суррогат', 't\ud800'],
  ])(
    'withTenant: идентификатор арендатора с %s — RangeError до запроса (сервер отверг бы или молча заменил)',
    async (_name, tenant) => {
      const sent: SQL[] = [];
      const tx = { execute: async (query: SQL) => sent.push(query), rollback: rollbackNever };
      await expect(withTenant(tx, tenant)).rejects.toThrow(RangeError);
      await expect(withTenant(tx, tenant)).rejects.toThrow('withTenant: идентификатор арендатора');
      expect(sent).toEqual([]);
    },
  );

  it.each([
    ['NUL', 'a\u0000b'],
    ['непарный суррогат', 'a\udc00'],
  ])('localSettings: значение с %s — RangeError с именем параметра до соединения', (_name, value) => {
    expect(() => localSettings({ localSettings: { 'app.x': value } })).toThrow(RangeError);
    expect(() => localSettings({ localSettings: { 'app.x': value } })).toThrow('localSettings.app.x');
  });

  it.each([
    ['NUL', 'job\u0000a'],
    ['непарный суррогат', 'job\ud800'],
  ])('ключ advisory-лока с %s — отказ до соединения', (_name, key) => {
    expect(() => advisoryLockKeySql(key)).toThrow(RangeError);
    expect(() => advisoryLockKeySql(key)).toThrow('withAdvisoryLock: ключ');
  });

  it('два ключа с разными непарными суррогатами не становятся одним локом: оба — отказ', () => {
    // Драйвер кодирует непарный суррогат в U+FFFD: «job\ud800» и «job\udbff» дали бы один лок.
    expect(Buffer.from('job\ud800').equals(Buffer.from('job\udbff'))).toBe(true);
    expect(() => advisoryLockKeySql('job\ud800')).toThrow(RangeError);
    expect(() => advisoryLockKeySql('job\udbff')).toThrow(RangeError);
    expect(advisoryLockKeySql('job😀').value).toBe('job😀');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('база %s — понятный отказ, а не TypeError чтения $client', async (_name, db) => {
    const work = async (): Promise<string> => 'x';
    await expect(transactionKeepingFailure(db as never, work)).rejects.toThrow(
      'transactionKeepingFailure: база обязана быть над пулом pg',
    );
    await expect(withAdvisoryLock(db as never, 'k', work, { timeoutMs: 100 })).rejects.toThrow(
      'transactionKeepingFailure: база обязана быть над пулом pg',
    );
    await expect(withSessionAdvisoryLock(db as never, 'k', work, { timeoutMs: 100 })).rejects.toThrow(
      'withSessionAdvisoryLock: база обязана быть пулом pg',
    );
    expect(() => assertPoolerCompatible(db as never)).toThrow('assertPoolerCompatible: ожидается пул pg');
    expect(() => poolStats(db as never)).toThrow('ожидается пул pg');
  });

  it('safeText и ошибки пакета: значение без прототипа, бросающий toPrimitive и геттер message не ломают сборку сообщения', () => {
    const bare = Object.create(null) as object;
    const hostile = {
      [Symbol.toPrimitive]: () => {
        throw new Error('toPrimitive');
      },
    };
    const getter = Object.defineProperty({}, 'message', {
      get: () => {
        throw new Error('getter');
      },
    });
    expect([safeText(bare), safeText(hostile), safeText(getter)]).toEqual([
      '[object Object]',
      '[object Object]',
      '[object Object]',
    ]);
    expect(safeText(new Error('текст'))).toBe('текст');
    expect(safeText(42)).toBe('42');
    const asError = toError(bare);
    expect([asError instanceof Error, asError.message, asError.cause]).toEqual([
      true,
      '[object Object]',
      bare,
    ]);
    expect(new TransactionRetryAbortedError(bare, hostile).message).toBe(
      'повтор транзакции отменён ([object Object]); последний отказ: [object Object]',
    );
    expect(new TransactionConnectionLostError('work', bare).message).toContain('[object Object]');
    expect(new CommitOutcomeUnknownError(bare).message).toContain('[object Object]');
    expect(new TransactionLeftOpenError('«k»', bare).message).toContain('[object Object]');
    expect(new TransactionCallbackError('retry.when', bare, hostile).message).toContain('[object Object]');
  });

  it('retry.when бросил — TransactionCallbackError из isRetryable, исходный отказ в cause', () => {
    const failure = new Error('отказ попытки');
    const broken = new Error('when');
    const retry = resolveRetry({
      attempts: 2,
      on: [],
      when: () => {
        throw broken;
      },
    });
    let thrown: unknown;
    try {
      isRetryable(failure, TRANSACTION_STAGE.work, retry);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TransactionCallbackError);
    expect([(thrown as Error).cause, (thrown as TransactionCallbackError).callbackError]).toEqual([
      failure,
      broken,
    ]);
  });

  it('sqlCode: тысячи $$-строк — работа проверки «место кода» линейна по длине текста (считаются символы, поданные регулярке, а не время)', () => {
    const scanned = (count: number): number => {
      const text = `SELECT ${Array.from({ length: count }, (_, i) => `$$s${i}$$`).join(', ')}`;
      const original = RegExp.prototype.test;
      let total = 0;
      const spy = jest.spyOn(RegExp.prototype, 'test').mockImplementation(function (
        this: RegExp,
        input: string,
      ) {
        total += input.length;
        return original.call(this, input);
      });
      try {
        expect(sqlCode(text)).toBe(`SELECT ${Array.from({ length: count }, () => "''").join(', ')}`);
      } finally {
        spy.mockRestore();
      }
      return total / text.length;
    };
    // Символов регулярке на символ текста: при 750 и 7500 строках — одинаково мало.
    // Квадратичная проверка по всему накопленному выводу даёт сотни и тысячи.
    expect(scanned(750)).toBeLessThan(5);
    expect(scanned(7500)).toBeLessThan(5);
  });

  it('codeTail: «место кода» по хвосту совпадает с проверкой по всему тексту (с длинными пробелами, LANGUAGE и границей слова)', () => {
    const outs = [
      'DO ',
      'DO',
      `DO${' '.repeat(5_000)}`,
      'SELECT 1; DO LANGUAGE plpgsql ',
      "SELECT 1; DO LANGUAGE '' ",
      'CREATE FUNCTION f() RETURNS int AS ',
      'x AS',
      'xAS ',
      'FOO_DO ',
      '$DO ',
      'BEGIN EXECUTE ',
      "SELECT '' , ",
      'DO LANGUAGE',
      'SELECT ',
      '',
      `${'a'.repeat(3_000)} DO\n\t `,
      'ALIAS DO LANGUAGE x y ',
    ];
    for (const out of outs) {
      expect([out.slice(0, 40), SQL_LEXEME.codePosition.test(codeTail(out))]).toEqual([
        out.slice(0, 40),
        SQL_LEXEME.codePosition.test(out),
      ]);
    }
    expect(outs.filter((out) => SQL_LEXEME.codePosition.test(out)).length).toBeGreaterThanOrEqual(6);
  });
});
