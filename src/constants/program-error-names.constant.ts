/**
 * Ошибки самой программы JS, а не сети: без `severity`/`code` сервера они
 * выглядели бы обрывом, и `connection-before-work` повторял бы их. Узнаются
 * по имени, а не `instanceof`: ошибка из другого контекста (vm, jest) — не
 * экземпляр здешнего TypeError.
 */
export const PROGRAM_ERROR_NAMES: readonly string[] = Object.freeze([
  'TypeError',
  'RangeError',
  'ReferenceError',
]);
