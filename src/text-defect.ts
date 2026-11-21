/**
 * Чем строка испортилась бы по дороге на сервер: NUL Postgres в тексте не
 * хранит (отказ 22021 посреди транзакции вызывающего), а непарный суррогат
 * драйвер молча кодирует в U+FFFD — две разные строки становятся одной
 * (ключ лока, арендатор). `undefined` — строка доедет как есть.
 */
export function textDefect(value: string): string | undefined {
  if (value.includes('\u0000')) {
    return 'содержит NUL (U+0000), который Postgres в тексте не хранит';
  }
  // `isWellFormed` есть в Node 20+ (ES2024); lib пакета — ES2023.
  if (!(value as string & { isWellFormed(): boolean }).isWellFormed()) {
    return 'содержит непарный суррогат UTF-16: драйвер заменил бы его на U+FFFD, и разные строки совпали бы';
  }
  return undefined;
}
