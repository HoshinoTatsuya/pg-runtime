/**
 * Отказ и его причины: сам, `cause` (wrapFailure кладёт исходную туда),
 * `driverError` — не глубже пяти звеньев (цикл в цепочке не вешает разбор).
 */
export function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (
    let current: unknown = error, depth = 0;
    current !== undefined && current !== null && depth < 5;
    depth += 1
  ) {
    chain.push(current);
    current =
      (current as { cause?: unknown; driverError?: unknown }).cause ??
      (current as { driverError?: unknown }).driverError;
  }
  return chain;
}
