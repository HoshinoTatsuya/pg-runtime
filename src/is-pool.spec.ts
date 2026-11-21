import { Client, Pool } from 'pg';

import { isPool } from './is-pool';
import { poolStats } from './pool-stats';
import { transactionKeepingFailure } from './transaction-keeping-failure';

/**
 * Проверка «база над пулом» — без базы: клиент, у которого есть `connect`, но
 * нет счётчиков пула, обязан быть отвергнут ДО обращения к нему (README
 * обещает отказ, а не «already connected» драйвера посреди вызова).
 */
describe('isPool и отказ «база не над пулом»', () => {
  const poolShape = { connect: () => undefined, totalCount: 0, idleCount: 0 };

  it('пул и пул другой копии pg (по форме) — да', () => {
    const pool = new Pool();
    try {
      expect(isPool(pool)).toBe(true);
      expect(isPool(poolShape)).toBe(true);
    } finally {
      void pool.end();
    }
  });

  it.each([
    ['клиент pg', new Client()],
    ['null', null],
    ['строка', 'pool'],
    ['без connect', { totalCount: 0, idleCount: 0 }],
    ['connect не функция', { connect: 1, totalCount: 0, idleCount: 0 }],
    ['без totalCount', { connect: () => undefined, idleCount: 0 }],
    ['без idleCount', { connect: () => undefined, totalCount: 0 }],
    ['счётчики строками', { connect: () => undefined, totalCount: '0', idleCount: '0' }],
  ])('%s — нет', (_name, candidate) => {
    expect(isPool(candidate)).toBe(false);
  });

  it('база над клиентом — отказ с причиной, connect клиента не вызывается', async () => {
    const connect = jest.fn();
    await expect(
      transactionKeepingFailure({ $client: { connect, totalCount: 'x' } } as never, async () => 'нет'),
    ).rejects.toThrow('база обязана быть над пулом pg');
    expect(connect).not.toHaveBeenCalled();
  });

  it('poolStats: снимок счётчиков пула и базы над ним; не пул — отказ', () => {
    const fake = { connect: () => undefined, totalCount: 5, idleCount: 2, waitingCount: 7 };
    expect(poolStats(fake)).toEqual({ total: 5, idle: 2, inUse: 3, waiting: 7 });
    expect(poolStats({ $client: fake })).toEqual({ total: 5, idle: 2, inUse: 3, waiting: 7 });
    expect(() => poolStats({ $client: new Client() })).toThrow('ожидается пул pg');
  });
});
