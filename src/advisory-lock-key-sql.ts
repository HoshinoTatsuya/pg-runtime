import { textDefect } from './text-defect';
import type { AdvisoryLockKey } from './types/advisory-lock-key.type';
import type { AdvisoryLockKeySql } from './types/advisory-lock-key-sql.type';

/**
 * Ключ advisory-лока — SQL-выражением от параметра `$1` и подписью для
 * отказа. Строка — `hashtextextended($1, 0)` (64 бита: совпадение ключей двух
 * подсистем на 32-битном `hashtext` уже не теоретическое), целое — само.
 */
export function advisoryLockKeySql(key: AdvisoryLockKey): AdvisoryLockKeySql {
  if (typeof key === 'string') {
    if (key.trim() === '' || key !== key.trim()) {
      throw new Error(`withAdvisoryLock: ключ «${key}» пуст или с пробелами по краям — это другой лок`);
    }
    const defect = textDefect(key);
    if (defect !== undefined) {
      throw new RangeError(`withAdvisoryLock: ключ ${defect} — отказ до соединения`);
    }
    return { expression: 'hashtextextended($1::text, 0)', value: key, label: `«${key}»` };
  }
  if (typeof key === 'number' && !Number.isSafeInteger(key)) {
    throw new Error(`withAdvisoryLock: числовой ключ — безопасное целое, получено ${key}`);
  }
  if (typeof key !== 'number' && typeof key !== 'bigint') {
    throw new Error(`withAdvisoryLock: ключ — строка, число или bigint, получено ${typeof key}`);
  }
  const value = BigInt(key);
  if (value < -(2n ** 63n) || value >= 2n ** 63n) {
    throw new Error(`withAdvisoryLock: ключ ${value} вне int8`);
  }
  return { expression: '$1::bigint', value: value.toString(), label: value.toString() };
}
