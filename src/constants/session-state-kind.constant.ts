import { deepFreeze } from '../deep-freeze';

/**
 * Виды состояния серверного соединения, которое переживает транзакцию:
 * под пулером в transaction mode его получает следующий клиент пулера.
 * Значение — колонка запроса сверки (`SESSION_PROBE_SQL`).
 */
export const SESSION_STATE_KIND = {
  /**
   * Параметр Postgres со значением сессии: `SET` без LOCAL, `set_config(…, false)`,
   * `SET SESSION CHARACTERISTICS`. Свои параметры (`app.*`) Postgres не показывает
   * ни в `pg_settings`, ни в `SHOW ALL` — их ловит только фильтр текста.
   */
  setting: 'setting',
  /** Роль сессии: `SET ROLE`, `SET SESSION AUTHORIZATION`. */
  role: 'role',
  /** Объект во временной схеме: таблица без ON COMMIT DROP, последовательность, представление, функция, тип. */
  temporaryObject: 'temporary_object',
  /** Курсор WITH HOLD. */
  holdableCursor: 'holdable_cursor',
  /** Подготовленный оператор (`PREPARE`, именованный оператор протокола). */
  preparedStatement: 'prepared_statement',
  /** Подписка `LISTEN`. */
  listenChannel: 'listen_channel',
  /** Сессионный advisory-лок. */
  advisoryLock: 'advisory_lock',
} as const;

deepFreeze(SESSION_STATE_KIND);
