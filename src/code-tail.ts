import { SQL_LEXEME } from './constants/sql-lexeme.constant';

/**
 * Хвост разобранного кода, по которому `SQL_LEXEME.codePosition` отвечает так
 * же, как по всему тексту: пробелы в конце и до трёх слов перед ними (слово —
 * символы идентификатора или `''` пустой строки) вместе с пробелами между
 * ними. Слово кончается на символе не из идентификатора, поэтому граница
 * `(?<![\p{L}\p{N}_$])` в начале хвоста та же, что в тексте. Проверка по всему
 * накопленному тексту на каждой `$`-кавычке была квадратичной: тысячи
 * `$$`-строк — десятки миллисекунд разбора на каждый запрос.
 */
export function codeTail(out: string): string {
  // Сколько слов с конца может занять `SQL_LEXEME.codePosition`: `DO LANGUAGE имя`.
  const codePositionWords = 3;
  const isSpace = (char: string): boolean => /\s/u.test(char);
  let start = out.length;
  const skipSpaces = (): void => {
    while (start > 0 && isSpace(out[start - 1] as string)) {
      start -= 1;
    }
  };
  skipSpaces();
  for (let word = 0; word < codePositionWords && start > 0; word += 1) {
    const end = start;
    if (out[start - 1] === "'" && out[start - 2] === "'") {
      start -= 2;
    } else {
      while (start > 0 && SQL_LEXEME.identifierChar.test(out[start - 1] as string)) {
        start -= 1;
      }
    }
    if (start === end) {
      break;
    }
    skipSpaces();
  }
  return out.slice(start);
}
