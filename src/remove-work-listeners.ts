import { WORK_LISTENER_CLEANUPS } from './constants/work-listener-cleanups.constant';

/**
 * Снимает слушатели, которые работа поставила на выданное ей соединение и не
 * сняла: соединение возвращается в пул и уходит следующему владельцу, а
 * замыкание прошлой работы не должно получать его события и копиться до
 * MaxListenersExceededWarning. Слушатели пакета и пула не трогаются. Повторный
 * вызов и вызов на соединении без обёртки — ничего не делают.
 */
export function removeWorkListeners(guarded: object): void {
  WORK_LISTENER_CLEANUPS.get(guarded)?.();
  WORK_LISTENER_CLEANUPS.delete(guarded);
}
