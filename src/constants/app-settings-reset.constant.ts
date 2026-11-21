/**
 * Сброс своих параметров (`resetAppSettings`) к значению по умолчанию сессии —
 * то же, что `RESET`: `set_config(имя, NULL, false)` возвращает параметр к
 * значению старта сессии (`ALTER ROLE/DATABASE … SET`, параметр стартового
 * пакета), а не делает его пустым (проверено на Postgres 15–18: умолчание базы
 * возвращается). Пустая строка (`set_config(…, '', false)`) сама оставила бы
 * сессионное значение — то самое состояние, которое сброс убирает.
 *
 * Параметр, которого в сессии нет (`current_setting(…, true)` — NULL), не
 * трогается: `RESET` объявил бы его, и сосед по пулеру видел бы `''` вместо NULL.
 * Имена — одним параметром-массивом (`$1`): в текст запроса ничего не подставляется.
 */
export const APP_SETTINGS_RESET_SQL =
  'SELECT pg_catalog.set_config(name, NULL, false) FROM pg_catalog.unnest($1::pg_catalog.text[]) AS name ' +
  'WHERE pg_catalog.current_setting(name, true) IS NOT NULL';
