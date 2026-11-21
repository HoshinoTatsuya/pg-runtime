import { POOLER_SESSION_FUNCTIONS } from './constants/pooler-session-functions.constant';
import { POOLER_SESSION_STATEMENTS } from './constants/pooler-session-statements.constant';
import { setConfigViolations } from './set-config-violations';
import { sqlCode } from './sql-code';

/**
 * Что в запросе ломается под пулером в transaction mode. `query` — первый
 * аргумент `client.query`: текст или конфигурация (`{ text, name, values }`),
 * `values` — второй (значения `$n`; без него — `query.values`).
 *
 * Распознаётся по тексту: от частых ошибок, а не полный разбор SQL. Комментарии
 * и содержимое строк в разбор не попадают (`SELECT '--'; SET …` не прячет SET),
 * неразобранный текст — отказ. Текст принципиально не видит состояния, которое
 * меняет функция или DO-блок изнутри (`EXECUTE 'SET …'`), — это ловит сверка
 * состояния серверного соединения после транзакции (`transactionPooler`).
 */
export function poolerViolations(query: unknown, values?: unknown): string[] {
  const config =
    typeof query === 'string'
      ? { text: query }
      : (query as { text?: unknown; name?: unknown; values?: unknown });
  const problems: string[] = [];
  if (typeof config?.name === 'string' && config.name !== '') {
    problems.push(`именованный подготовленный оператор «${config.name}» живёт на одном серверном соединении`);
  }
  if (typeof config?.text !== 'string') {
    return problems;
  }
  const code = sqlCode(config.text);
  if (code === undefined) {
    problems.push(
      'текст запроса не разобран (незакрытая строка, комментарий или $-кавычка) — сессионное состояние не проверить',
    );
    return problems;
  }
  const statements = code.split(';').map((statement) => statement.trim());
  for (const [pattern, problem] of POOLER_SESSION_STATEMENTS) {
    if (statements.some((statement) => pattern.test(statement))) {
      problems.push(problem);
    }
  }
  for (const [pattern, problem] of POOLER_SESSION_FUNCTIONS) {
    if (pattern.test(code)) {
      problems.push(problem);
    }
  }
  const parameters = Array.isArray(values)
    ? values
    : Array.isArray(config.values)
      ? config.values
      : undefined;
  problems.push(...setConfigViolations(code, parameters));
  return problems;
}
