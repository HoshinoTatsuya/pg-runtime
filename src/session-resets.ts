import type { PoolClient } from 'pg';

/**
 * Уборка сессии с базовой линией `connect` — по соединению пула: снимок
 * состояния после connect берётся один раз на соединение (первая транзакция
 * с `resetSession`), запрос уборки строится из него тогда же. Соединение
 * уничтожено — запись уходит вместе с ним.
 */
export const SESSION_RESETS = new WeakMap<PoolClient, string>();
