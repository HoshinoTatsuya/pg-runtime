/**
 * Снимок состояния соединения — один источник для сверки под пулером
 * (`transactionPooler`) и для базовой линии уборки (`resetSession` с
 * `SESSION_BASELINE.connect`). Сверка под пулером: одна строка, колонка на
 * вид (`SESSION_STATE_KIND`), в каждой — отсортированный `text[]`. Читается
 * в начале транзакции (тем же сообщением, что BEGIN) и сразу после COMMIT или
 * ROLLBACK (тем же сообщением): пулер отдаёт серверное соединение другому
 * клиенту только по готовности после ВСЕГО сообщения, поэтому оба снимка — с
 * одного серверного соединения. Состояние до транзакции (его мог оставить
 * чужой клиент пулера) не вменяется: судится разница.
 *
 * - параметры — `pg_settings` с источником `session` (ни `SET LOCAL`, ни
 *   `set_config(…, true)` после транзакции там не остаются); параметры самой
 *   транзакции (`transaction_*`) не сравниваются: в начальном снимке они уже
 *   от BEGIN. Свои параметры (`app.*`) там не видны вовсе (Postgres скрывает
 *   их и из `SHOW ALL`) — их держит только фильтр текста;
 * - роль — `session_user`/`current_user`, по элементу на каждого (`имя = значение`,
 *   как у параметров: снимок разбирает и уборка `resetSession`, восстанавливая
 *   базовую линию): `role` и `session_authorization` в `pg_settings` не видны;
 * - временные объекты — зависимости от временной схемы этой сессии
 *   (`pg_depend` по индексу, а не обход `pg_class`: на базе с сотнями тысяч
 *   таблиц сверка стоила бы миллисекунды);
 * - курсоры WITH HOLD, подготовленные операторы, `pg_listening_channels()`,
 *   advisory-локи этой сессии (после COMMIT/ROLLBACK остаются только сессионные).
 */
export const SESSION_PROBE_SQL = `SELECT
  ARRAY(SELECT name || ' = ' || setting FROM pg_catalog.pg_settings
        WHERE source = 'session' AND name NOT LIKE 'transaction\\_%' ORDER BY 1) AS setting,
  ARRAY[pg_catalog.format('current_user = %s', current_user), pg_catalog.format('session_user = %s', session_user)] AS role,
  ARRAY(SELECT pg_catalog.pg_describe_object(classid, objid, objsubid) FROM pg_catalog.pg_depend
        WHERE refclassid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
          AND refobjid = pg_catalog.pg_my_temp_schema() AND refobjid <> 0 ORDER BY 1) AS temporary_object,
  ARRAY(SELECT name::text FROM pg_catalog.pg_cursors WHERE is_holdable ORDER BY 1) AS holdable_cursor,
  ARRAY(SELECT name::text FROM pg_catalog.pg_prepared_statements ORDER BY 1) AS prepared_statement,
  ARRAY(SELECT c::text FROM pg_catalog.pg_listening_channels() AS c ORDER BY 1) AS listen_channel,
  ARRAY(SELECT pg_catalog.format('%s:%s:%s %s', classid, objid, objsubid, mode) FROM pg_catalog.pg_locks
        WHERE locktype = 'advisory' AND pid = pg_catalog.pg_backend_pid() AND granted ORDER BY 1) AS advisory_lock`;
