import { PERMANENT_CONNECT_REFUSAL } from './constants/permanent-connect-refusal.constant';
import { PROGRAM_ERROR_NAMES } from './constants/program-error-names.constant';
import { errorChain } from './error-chain';
import { isConnectionFailure } from './is-connection-failure';

/**
 * Обрыв, который повтор может исправить (`connection-before-work`): обрыв
 * (`isConnectionFailure`), кроме ошибки программы (`TypeError`, `RangeError`,
 * `ReferenceError` в цепочке — серверного кода у неё нет, и обрывом она
 * выглядела бы только по отсутствию кода) и отказа подключения, который
 * повтор не исправит (`PERMANENT_CONNECT_REFUSAL`: пароль, роль, база).
 *
 * Отдельно от `isConnectionFailure`: тот отвечает «ответил ли сервер» —
 * по нему отказ COMMIT судится как «исход неизвестен», и ошибка программы
 * посреди ответа на COMMIT обязана оставаться неизвестным исходом.
 */
export function isTransientConnectionFailure(error: unknown): boolean {
  if (!isConnectionFailure(error)) {
    return false;
  }
  return !errorChain(error).some((link) => {
    const { name, code, severity } = (link ?? {}) as { name?: unknown; code?: unknown; severity?: unknown };
    if (typeof name === 'string' && PROGRAM_ERROR_NAMES.includes(name)) {
      return true;
    }
    return (
      typeof severity === 'string' &&
      typeof code === 'string' &&
      (PERMANENT_CONNECT_REFUSAL.codes.includes(code) ||
        PERMANENT_CONNECT_REFUSAL.classes.some((prefix) => code.startsWith(prefix)))
    );
  });
}
