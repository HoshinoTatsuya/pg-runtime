import { TIMER_LIMIT } from './constants/timer-limit.constant';
import { TRANSACTION_RETRY_DEFAULTS } from './constants/transaction-retry-defaults.constant';
import { retryDelayMs } from './retry-delay-ms';

describe('retryDelayMs — пауза перед повтором транзакции', () => {
  const half = () => 0.5;

  it('без backoffMs — ненулевая база по умолчанию, а не немедленный повтор', () => {
    expect(retryDelayMs(1, undefined, half)).toBe(TRANSACTION_RETRY_DEFAULTS.BACKOFF_MS / 2);
    expect(retryDelayMs(1, undefined, half)).toBeGreaterThan(0);
  });

  it('растёт вдвое с каждой попыткой', () => {
    expect([1, 2, 3, 4].map((attempt) => retryDelayMs(attempt, 100, half))).toEqual([50, 100, 200, 400]);
  });

  it('full jitter: доля от 0 до полной паузы', () => {
    expect(retryDelayMs(3, 100, () => 0)).toBe(0);
    expect(retryDelayMs(3, 100, () => 0.999)).toBeCloseTo(399.6);
  });

  it('явный backoffMs: 0 — без паузы (выбор вызывающего)', () => {
    expect(retryDelayMs(2, 0, half)).toBe(0);
  });

  it('не выше потолка таймера', () => {
    expect(retryDelayMs(40, 1_000, () => 1)).toBe(TIMER_LIMIT.MAX_DELAY_MS);
  });

  it('огромный номер попытки (2^(n−1) = Infinity): пауза — число в пределах потолка, а не NaN', () => {
    for (const random of [() => 0, () => 0.5, () => 1]) {
      for (const base of [0, 25, undefined]) {
        const delay = retryDelayMs(1025, base, random);
        expect([base, Number.isFinite(delay), delay <= TIMER_LIMIT.MAX_DELAY_MS]).toEqual([base, true, true]);
      }
    }
    expect(retryDelayMs(1025, 25, () => 0)).toBe(0);
  });
});
