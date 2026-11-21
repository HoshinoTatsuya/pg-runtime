import { safeText } from './safe-text';

/** Отказ как `Error`: `release(error)` пула и наблюдатель ждут Error. Исходное значение — в `cause`. */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(safeText(value), { cause: value });
}
