/**
 * Операторы, оставляющие состояние серверного соединения после транзакции.
 * Проверяется НАЧАЛО каждого оператора кода запроса (`sqlCode`, деление по `;`):
 * `UPDATE t SET a = 1` и `SELECT 'SET x'` — не настройка.
 */
export const POOLER_SESSION_STATEMENTS: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
  [/^SET\s+(?!LOCAL\b|TRANSACTION\b|CONSTRAINTS\b)/i, 'SET без LOCAL остаётся на серверном соединении'],
  [/^RESET\b/i, 'RESET меняет параметры серверного соединения'],
  [/^(?:UN)?LISTEN\b/i, 'LISTEN/UNLISTEN — подписка серверного соединения'],
  [/^PREPARE\b/i, 'PREPARE — оператор серверного соединения'],
  [/^DEALLOCATE\b/i, 'DEALLOCATE снимает операторы серверного соединения (в том числе пулера)'],
  [/^DECLARE\b[\s\S]*\bWITH\s+HOLD\b/i, 'курсор WITH HOLD переживает транзакцию'],
  [/^DISCARD\b/i, 'DISCARD меняет серверное соединение'],
  [/^LOAD\b/i, 'LOAD загружает библиотеку в серверное соединение'],
  [
    /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL|LOCAL)\s+)?TEMP(?:ORARY)?\s+(?!TABLE\b)/i,
    'временные последовательность и представление живут до конца серверного соединения (ON COMMIT DROP у них нет)',
  ],
  [
    /^CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?TEMP(?:ORARY)?\s+TABLE\b(?![\s\S]*\bON\s+COMMIT\s+DROP\b)/i,
    'временная таблица без ON COMMIT DROP живёт до конца серверного соединения',
  ],
  [
    /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:UNLOGGED\s+)?(?:MATERIALIZED\s+)?(?:RECURSIVE\s+)?(?!TABLE\b)\w+\s+(?:IF\s+NOT\s+EXISTS\s+)?pg_temp\s*\./i,
    'объект в pg_temp живёт до конца серверного соединения',
  ],
  [
    /^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?pg_temp\s*\.(?![\s\S]*\bON\s+COMMIT\s+DROP\b)/i,
    'таблица в pg_temp без ON COMMIT DROP живёт до конца серверного соединения',
  ],
  [
    /^(?:WITH\b|SELECT\b|\()[\s\S]*(?<!\b(?:INSERT|MERGE)\s+)\bINTO\s+(?:(?:(?:GLOBAL|LOCAL)\s+)?TEMP(?:ORARY)?\b|(?:TABLE\s+)?pg_temp\s*\.)/i,
    'SELECT … INTO TEMP — временная таблица без ON COMMIT DROP',
  ],
] as const);
