import { deepFreeze } from '../deep-freeze';

/**
 * Предел задержки таймера Node (2^31 − 1 мс): `setTimeout` с большим значением
 * не ждёт дольше, а срабатывает через 1 мс с TimeoutOverflowWarning. Пауза
 * повтора `backoffMs × 2^(попытка−1)` при большом числе попыток выходит за
 * него — и повтор превращался бы в немедленный.
 */
export const TIMER_LIMIT = {
  MAX_DELAY_MS: 2_147_483_647,
} as const;

deepFreeze(TIMER_LIMIT);
