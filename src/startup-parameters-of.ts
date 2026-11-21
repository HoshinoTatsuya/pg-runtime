import { createRequire } from 'node:module';

import { POOLER_STARTUP_PARAMETERS } from './constants/pooler-startup-parameters.constant';

/**
 * Параметры старта сессии, которые pg РЕАЛЬНО отправит для конфигурации пула,
 * по источникам. Читается тем же кодом, которым их читает сам pg
 * (`pg/lib/connection-parameters` и его разбор строки подключения), а не
 * своим повтором: свой разбор расходился с драйвером (строка без хоста,
 * `PGOPTIONS` из окружения, `pg.defaults`). pg шлёт параметр, только если
 * значение истинно — так же он и проверяется здесь.
 *
 * `connectionString` — значения из строки; `undefined`, если строки нет;
 * `null`, если строка не разобрана (сервер её тоже не примет, а «не разобрал»
 * не должно стать «параметров нет»).
 */
export function startupParametersOf(config: Record<string, unknown>): {
  readonly pool: readonly string[];
  readonly connectionString: readonly string[] | undefined | null;
  readonly effective: readonly string[];
} {
  const pgRequire = createRequire(require.resolve('pg/lib/connection-parameters'));
  const ConnectionParameters = pgRequire('pg/lib/connection-parameters') as new (
    config: Record<string, unknown>,
  ) => Record<string, unknown>;
  const parse = (
    pgRequire('pg-connection-string') as {
      parse: (text: string) => Record<string, unknown>;
    }
  ).parse;
  const sent = (source: Record<string, unknown>): string[] =>
    POOLER_STARTUP_PARAMETERS.filter((name) => Boolean(source[name]));
  let connectionString: string[] | undefined | null;
  if (typeof config.connectionString === 'string') {
    try {
      connectionString = sent(parse(config.connectionString));
    } catch {
      connectionString = null;
    }
  }
  return { pool: sent(config), connectionString, effective: sent(new ConnectionParameters(config)) };
}
