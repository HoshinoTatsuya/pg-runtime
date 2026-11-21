import { commitFailure } from './commit-failure';
import { CommitOutcomeUnknownError } from './commit-outcome-unknown.error';
import { RETRY_REASON } from './constants/retry-reason.constant';
import { TRANSACTION_STAGE } from './constants/transaction-stage.constant';
import { isConnectionFailure } from './is-connection-failure';
import { isRetryable } from './is-retryable';
import { resolveRetry } from './resolve-retry';

const server = (severity: string, code: string): Error => Object.assign(new Error(code), { severity, code });

describe('классификация отказов', () => {
  it.each([
    ['ошибка сокета', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), true],
    ['Connection terminated', new Error('Connection terminated unexpectedly'), true],
    ['FATAL', server('FATAL', '25P03'), true],
    ['PANIC', server('PANIC', 'XX000'), true],
    ['класс 08', server('ERROR', '08006'), true],
    ['57P01', server('ERROR', '57P01'), true],
    ['57P03', server('ERROR', '57P03'), true],
    ['ERROR запроса', server('ERROR', '23505'), false],
    ['ERROR в cause', Object.assign(new Error('обёртка'), { cause: server('ERROR', '40001') }), false],
    [
      'FATAL в driverError',
      Object.assign(new Error('обёртка'), { driverError: server('FATAL', '57P01') }),
      true,
    ],
  ])('isConnectionFailure: %s → %s', (_name, error, expected) => {
    expect(isConnectionFailure(error)).toBe(expected);
  });

  it.each([
    // Ошибки программы, а не сети: повтор как обрыв только тратит время.
    ['TypeError', new TypeError("Cannot read properties of undefined (reading 'x')"), false],
    ['RangeError', new RangeError('Invalid array length'), false],
    ['ReferenceError', new ReferenceError('x is not defined'), false],
    ['TypeError в cause', new Error('обёртка', { cause: new TypeError('x') }), false],
    // FATAL при подключении, который повтор не исправит: роль, пароль, база.
    ['FATAL 28P01 неверный пароль', server('FATAL', '28P01'), false],
    ['FATAL 28000 нет права входа / pg_hba', server('FATAL', '28000'), false],
    ['FATAL 3D000 нет базы', server('FATAL', '3D000'), false],
    // Двойники: переходящие отказы подключения — обрыв, повтор уместен.
    ['FATAL 53300 слишком много соединений', server('FATAL', '53300'), true],
    ['FATAL 57P03 сервер стартует', server('FATAL', '57P03'), true],
    ['обрыв сокета', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), true],
  ])('isRetryable connection-before-work на BEGIN: %s → %s', (_name, error, expected) => {
    const retry = resolveRetry({ attempts: 2, on: [RETRY_REASON.connectionBeforeWork] });
    expect(isRetryable(error, TRANSACTION_STAGE.begin, retry)).toBe(expected);
  });

  it('isConnectionFailure: TypeError — «сервер не ответил» (для исхода COMMIT это неизвестный исход, а не «не записано»)', () => {
    expect(isConnectionFailure(new TypeError('x'))).toBe(true);
    expect(commitFailure(new TypeError('x'), { ok: false, error: new Error('x') })).toBeInstanceOf(
      CommitOutcomeUnknownError,
    );
  });

  it('commitFailure: ответ сервера — сам отказ; обрыв + откат открытой транзакции — сам отказ; иначе неизвестно', () => {
    const rejected = server('ERROR', '23505');
    const dropped = new Error('Connection terminated unexpectedly');
    expect(commitFailure(rejected, { ok: false, error: new Error('x') })).toBe(rejected);
    expect(commitFailure(dropped, { ok: true, notices: [] })).toBe(dropped);
    const afterNoTransaction = commitFailure(dropped, { ok: true, notices: ['25P01'] });
    expect(afterNoTransaction).toBeInstanceOf(CommitOutcomeUnknownError);
    expect((afterNoTransaction as Error).cause).toBe(dropped);
    expect(commitFailure(dropped, { ok: false, error: new Error('not queryable') })).toBeInstanceOf(
      CommitOutcomeUnknownError,
    );
  });

  it('isRetryable: по причинам on; исход COMMIT неизвестен — никогда', () => {
    const defaults = resolveRetry({ attempts: 2 });
    const work = TRANSACTION_STAGE.work;
    expect(isRetryable(server('ERROR', '40001'), work, defaults)).toBe(true);
    expect(isRetryable(server('ERROR', '40P01'), work, defaults)).toBe(true);
    expect(isRetryable(server('ERROR', '55P03'), work, defaults)).toBe(false);
    expect(
      isRetryable(Object.assign(new Error('w'), { cause: server('ERROR', '40001') }), work, defaults),
    ).toBe(true);
    expect(isRetryable(new CommitOutcomeUnknownError(server('ERROR', '40001')), work, defaults)).toBe(false);
    const lock = resolveRetry({ attempts: 2, on: [RETRY_REASON.lockTimeout] });
    expect(isRetryable(server('ERROR', '55P03'), work, lock)).toBe(true);
    expect(isRetryable(server('ERROR', '40001'), work, lock)).toBe(false);
  });

  it('isRetryable: обрыв до работы — только на стадии BEGIN и только обрыв', () => {
    const retry = resolveRetry({ attempts: 2, on: [RETRY_REASON.connectionBeforeWork] });
    const dropped = new Error('Connection terminated unexpectedly');
    expect(isRetryable(dropped, TRANSACTION_STAGE.begin, retry)).toBe(true);
    expect(isRetryable(dropped, TRANSACTION_STAGE.work, retry)).toBe(false);
    expect(isRetryable(dropped, TRANSACTION_STAGE.commit, retry)).toBe(false);
    expect(isRetryable(server('ERROR', '42501'), TRANSACTION_STAGE.begin, retry)).toBe(false);
  });

  it('isRetryable: цепочка cause не глубже пяти звеньев и не зацикливается', () => {
    const retry = resolveRetry({ attempts: 2 });
    let deep: unknown = server('ERROR', '40001');
    for (let index = 0; index < 4; index += 1) {
      deep = Object.assign(new Error(`звено ${index}`), { cause: deep });
    }
    expect(isRetryable(deep, TRANSACTION_STAGE.work, retry)).toBe(true);
    const deeper = Object.assign(new Error('шестое'), { cause: deep });
    expect(isRetryable(deeper, TRANSACTION_STAGE.work, retry)).toBe(false);
    const loop: { message: string; cause?: unknown } = { message: 'цикл' };
    loop.cause = loop;
    expect(isRetryable(loop, TRANSACTION_STAGE.work, retry)).toBe(false);
  });

  it('resolveRetry: проверка до соединения', () => {
    expect(resolveRetry(undefined).attempts).toBe(1);
    expect(() => resolveRetry({ attempts: 0 })).toThrow('retry.attempts — целое больше нуля');
    expect(() => resolveRetry({ attempts: 1.5 })).toThrow('retry.attempts — целое больше нуля');
    expect(() => resolveRetry({ attempts: 2, backoffMs: -1 })).toThrow('retry.backoffMs — неотрицательное');
    expect(() => resolveRetry({ attempts: 2, backoffMs: Number.NaN })).toThrow('retry.backoffMs');
    expect(resolveRetry({ attempts: 2, backoffMs: 0 }).backoffMs).toBe(0);
    expect(() => resolveRetry({ attempts: 2, on: [] })).toThrow('повторять нечего');
    expect(() => resolveRetry({ attempts: 2, when: 'x' as never })).toThrow('retry.when — функция');
  });
});
