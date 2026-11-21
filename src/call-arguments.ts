/**
 * Аргументы вызова верхнего уровня от `(` на позиции `open` в коде без строк
 * (`sqlCode`): вложенные `(…)` и `[…]` не делят. `undefined` — скобки не закрыты.
 */
export function callArguments(code: string, open: number): string[] | undefined {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < code.length; i += 1) {
    const char = code[i];
    if (char === '(' || char === '[') {
      depth += 1;
    } else if (char === ')' || char === ']') {
      depth -= 1;
      if (depth === 0) {
        args.push(code.slice(start, i).trim());
        return args;
      }
    } else if (char === ',' && depth === 1) {
      args.push(code.slice(start, i).trim());
      start = i + 1;
    }
  }
  return undefined;
}
