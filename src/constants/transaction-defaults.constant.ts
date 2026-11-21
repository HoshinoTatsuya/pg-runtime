import { deepFreeze } from '../deep-freeze';

export const TRANSACTION_DEFAULTS = {
  /**
   * Потолок служебного запроса пакета, мс: ROLLBACK, уборка сессии, снятие
   * сессионного advisory-лока, запрос опроса лока у самого потолка ожидания.
   * Эти запросы сервер выполняет мгновенно (откат помечает транзакцию
   * прерванной), поэтому ожидание дольше — это «молчащее» соединение (сеть
   * замёрзла, сервер завис): без потолка оно держало бы слот пула до таймаута
   * TCP ОС, то есть минуты. По потолку соединение уничтожается.
   */
  ROLLBACK_TIMEOUT_MS: 5_000,
  /** Интервал опроса advisory-лока в `withAdvisoryLock`, мс. */
  ADVISORY_LOCK_POLL_MS: 50,
  /** Параметр контекста арендатора для политик RLS (`current_setting('app.tenant_id', true)`). */
  TENANT_SETTING: 'app.tenant_id',
} as const;

deepFreeze(TRANSACTION_DEFAULTS);
