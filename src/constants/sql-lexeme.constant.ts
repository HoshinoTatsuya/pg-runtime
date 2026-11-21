/**
 * Лексемы SQL для `sqlCode`: символ идентификатора (буквы любого алфавита,
 * цифры, `_`, `$`), открывающая `$`-кавычка (`$$`, `$тег$`; тег не с цифры —
 * `$1` это параметр), простой идентификатор, который в кавычках значит то же,
 * что без них, место, где `$`-кавычка — исполняемый код, а не строка (после
 * `DO`, `DO LANGUAGE имя`, `AS` тела функции и `EXECUTE` PL/pgSQL), и ключевые
 * слова PL/pgSQL, после которых в теле начинается оператор (`BEGIN SET …`).
 */
export const SQL_LEXEME = Object.freeze({
  identifierChar: /[\p{L}\p{N}_$]/u,
  dollarTag: /^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u,
  simpleIdentifier: /^[\p{L}_][\p{L}\p{N}_$]*$/u,
  codePosition: /(?<![\p{L}\p{N}_$])(?:DO|AS|EXECUTE|DO\s+LANGUAGE\s+(?:[\p{L}_][\p{L}\p{N}_$]*|''))\s*$/iu,
  blockKeyword: /(?<![\p{L}\p{N}_$])(BEGIN|THEN|ELSE|LOOP)(?![\p{L}\p{N}_$])/giu,
});
