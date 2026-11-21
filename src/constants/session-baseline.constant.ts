import { deepFreeze } from '../deep-freeze';

/**
 * К какому состоянию `resetSession` возвращает соединение пула после работы.
 */
export const SESSION_BASELINE = {
  /**
   * По умолчанию: к состоянию, в котором соединение пришло в первую транзакцию
   * с `resetSession` — со всем, что задал обработчик `pool.on('connect')`
   * (`SET search_path`, `SET TIME ZONE`, `SET ROLE`, `LISTEN`). Снимок — тем же
   * запросом и тем же сообщением, что сверка `transactionPooler`, один раз на
   * соединение.
   */
  connect: 'connect',
  /**
   * К значениям по умолчанию сессии (`RESET ALL`): остаются параметры старта
   * сессии и `ALTER ROLE/DATABASE … SET`, заданное на connect теряется. Без снимка.
   */
  defaults: 'defaults',
} as const;

deepFreeze(SESSION_BASELINE);
