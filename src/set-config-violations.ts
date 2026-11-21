import { callArguments } from './call-arguments';
import { SET_CONFIG_LOCAL } from './constants/set-config-local.constant';

/**
 * `set_config(имя, значение, is_local)`, у которого `is_local` не доказан
 * равным true: литерал `true` или параметр `$n` со значением `true` (`'true'`,
 * `'t'`, `'on'`, `'yes'`, `'y'`, `'1'` — как его прочтёт сервер). Всё прочее —
 * `false`, `'f'`, выражение, параметр с другим значением или без значения,
 * неразобранный вызов — отказ: текст не доказывает, что параметр уйдёт вместе
 * с транзакцией, а «не доказано» здесь — сессионный параметр у соседа пулера.
 * `code` — результат `sqlCode` (строки уже без содержимого).
 */
export function setConfigViolations(code: string, values: readonly unknown[] | undefined): string[] {
  const problems: string[] = [];
  for (const match of code.matchAll(SET_CONFIG_LOCAL.call)) {
    const args = callArguments(code, match.index + match[0].length - 1);
    const isLocal = args?.length === 3 ? args[2] : undefined;
    if (isLocal === undefined) {
      problems.push('set_config: вызов не разобран — третий аргумент (is_local) не проверить');
      continue;
    }
    if (SET_CONFIG_LOCAL.literal.test(isLocal)) {
      continue;
    }
    const parameter = SET_CONFIG_LOCAL.parameter.exec(isLocal);
    if (parameter !== null) {
      const value = values?.[Number(parameter[1]) - 1];
      if (value === true || (typeof value === 'string' && SET_CONFIG_LOCAL.trueText.test(value))) {
        continue;
      }
      problems.push(
        `set_config(…, $${parameter[1]}): значение параметра is_local — ${JSON.stringify(value) ?? 'нет'}, ` +
          'а не true — параметр сессии',
      );
      continue;
    }
    problems.push(`set_config(…, ${isLocal}): is_local не литерал true — параметр сессии`);
  }
  return problems;
}
