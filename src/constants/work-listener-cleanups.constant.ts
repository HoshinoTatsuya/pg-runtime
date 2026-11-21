/**
 * Обёртка соединения работы → снятие слушателей, которые работа поставила и
 * не сняла. Заполняет `guardedClient`, вызывает `removeWorkListeners` с концом
 * работы. Слабая карта: обёртка, ставшая недостижимой, уходит вместе с записью.
 */
export const WORK_LISTENER_CLEANUPS = new WeakMap<object, () => void>();
