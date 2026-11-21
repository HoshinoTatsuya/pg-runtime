/**
 * Строковая константа SQL в `$`-кавычках: не зависит от
 * `standard_conforming_strings` и не требует экранирования. Метка подбирается
 * так, чтобы первое вхождение закрывающей метки было ровно в конце значения:
 * значение, само содержащее `$q$` или кончающееся на `$q`, получает другую метку.
 */
export function dollarQuoted(value: string): string {
  for (let index = 0; ; index += 1) {
    const tag = index === 0 ? '$q$' : `$q${index}$`;
    if (`${value}${tag}`.indexOf(tag) === value.length) {
      return `${tag}${value}${tag}`;
    }
  }
}
