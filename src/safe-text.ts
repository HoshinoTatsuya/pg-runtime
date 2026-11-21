/**
 * Текст значения для сообщения об отказе, который сам не бросает: `message`
 * (у Error и у объекта той же формы), иначе `String(value)`, а если и тот
 * бросает (объект без прототипа, `Symbol.toPrimitive` с отказом, Proxy) —
 * `Object.prototype.toString`. Отказ, брошенный при сборке сообщения, заменил
 * бы исходный и сорвал бы уборку соединения, которая шла следом.
 */
export function safeText(value: unknown): string {
  try {
    const message = (value as { message?: unknown } | null | undefined)?.message;
    if (typeof message === 'string') {
      return message;
    }
  } catch {
    // Геттер `message` бросил — текст берётся иначе.
  }
  try {
    return String(value);
  } catch {
    // Значение не приводится к строке — ниже тег объекта.
  }
  try {
    return Object.prototype.toString.call(value);
  } catch {
    return '[значение без текста]';
  }
}
