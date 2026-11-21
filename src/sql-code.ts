import { codeTail } from './code-tail';
import { SQL_LEXEME } from './constants/sql-lexeme.constant';

/**
 * Код запроса без данных: комментарии (вложенные `/* … *\/` тоже) — пробел,
 * содержимое строк в одинарных кавычках (и `E'…'` с `\'`) — `''`, простой
 * идентификатор в кавычках — без кавычек (`"set_config"` — тот же вызов),
 * остальные — `_`. Тело в `$…$`-кавычках там, где Postgres его исполняет
 * (`DO`, `AS` тела функции, `EXECUTE` в PL/pgSQL), — код: разбирается так же и
 * обрамляется `;`, а после `BEGIN`/`THEN`/`ELSE`/`LOOP` PL/pgSQL ставится `;`,
 * чтобы операторы внутри начинались оператором; тело, которое кодом не
 * разбирается (`DO $$it's$$`), — `''`. В любом другом месте `$…$` — строка,
 * как `'…'`: `SELECT $q$SET x$q$` состояния не меняет.
 *
 * `undefined` — текст не разобран: незакрытая строка, идентификатор,
 * комментарий или `$`-кавычка. Сервер такой текст тоже отвергнет, а проверка
 * обязана считать «не разобрал» отказом, а не «безопасно». Строки читаются
 * так, как их читает сервер с `standard_conforming_strings = on` (умолчание
 * с 9.1): `\` в обычной строке — просто символ.
 */
export function sqlCode(text: string): string | undefined {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i] as string;
    const next = text[i + 1];
    if (char === '-' && next === '-') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      out += ' ';
      continue;
    }
    if (char === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      if (depth > 0) {
        return undefined;
      }
      i = j;
      out += ' ';
      continue;
    }
    if (char === "'") {
      const before = text[i - 1];
      const escapes =
        (before === 'e' || before === 'E') &&
        (i < 2 || !SQL_LEXEME.identifierChar.test(text[i - 2] as string));
      let j = i + 1;
      let closed = false;
      while (j < text.length) {
        if (escapes && text[j] === '\\') {
          j += 2;
        } else if (text[j] === "'" && text[j + 1] === "'") {
          j += 2;
        } else if (text[j] === "'") {
          closed = true;
          break;
        } else {
          j += 1;
        }
      }
      if (!closed) {
        return undefined;
      }
      i = j + 1;
      out += "''";
      continue;
    }
    if (char === '"') {
      let j = i + 1;
      let name = '';
      let closed = false;
      while (j < text.length) {
        if (text[j] === '"' && text[j + 1] === '"') {
          name += '"';
          j += 2;
        } else if (text[j] === '"') {
          closed = true;
          break;
        } else {
          name += text[j];
          j += 1;
        }
      }
      if (!closed) {
        return undefined;
      }
      i = j + 1;
      out += SQL_LEXEME.simpleIdentifier.test(name) ? name : '_';
      continue;
    }
    if (char === '$' && (i === 0 || !SQL_LEXEME.identifierChar.test(text[i - 1] as string))) {
      const tag = SQL_LEXEME.dollarTag.exec(text.slice(i))?.[0];
      if (tag !== undefined) {
        const end = text.indexOf(tag, i + tag.length);
        if (end === -1) {
          return undefined;
        }
        const body = SQL_LEXEME.codePosition.test(codeTail(out))
          ? sqlCode(text.slice(i + tag.length, end))
          : undefined;
        out += body === undefined ? "''" : `;${body.replace(SQL_LEXEME.blockKeyword, '$1;')};`;
        i = end + tag.length;
        continue;
      }
    }
    out += char;
    i += 1;
  }
  return out;
}
