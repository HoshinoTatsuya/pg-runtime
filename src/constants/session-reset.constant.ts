/**
 * Уборка сессионного состояния, которое работа оставила на соединении пула
 * (`resetSession`): курсоры WITH HOLD, `SET SESSION AUTHORIZATION`, `SET` без
 * LOCAL, `LISTEN`, сессионные advisory-локи, временные таблицы, состояние
 * последовательностей. Это `DISCARD ALL` БЕЗ `DEALLOCATE ALL`: pg помнит
 * подготовленные им именованные операторы у соединения, и после снятия их на
 * сервере следующий запрос с тем же именем отвечал бы «prepared statement does
 * not exist». Одним запросом — одно обращение к базе.
 */
export const SESSION_RESET_SQL =
  'CLOSE ALL; SET SESSION AUTHORIZATION DEFAULT; RESET ALL; UNLISTEN *; ' +
  'SELECT pg_advisory_unlock_all(); DISCARD TEMP; DISCARD SEQUENCES';
