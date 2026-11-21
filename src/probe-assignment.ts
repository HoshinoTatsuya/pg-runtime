/**
 * Элемент снимка состояния соединения вида `имя = значение`
 * (`SESSION_PROBE_SQL`): имя — до первого ` = ` (в именах параметров и в
 * `session_user`/`current_user` пробелов нет). Иная форма — отказ: «не
 * разобрал» не должно стать «восстанавливать нечего».
 */
export function probeAssignment(item: string): readonly [string, string] {
  const at = item.indexOf(' = ');
  if (at <= 0) {
    throw new Error(`снимок состояния соединения не разобран: «${item}»`);
  }
  return [item.slice(0, at), item.slice(at + 3)];
}
