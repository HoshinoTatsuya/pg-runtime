import { SESSION_STATE_KIND } from './constants/session-state-kind.constant';
import type { SessionState } from './types/session-state.type';

/**
 * Снимок из строки сверки (`SESSION_PROBE_SQL`). Колонки нет или она не
 * массив строк — отказ: «не прочитал» не должно стать «ничего не изменилось».
 */
export function sessionStateOf(row: unknown): SessionState {
  const state: Record<string, readonly string[]> = {};
  for (const kind of Object.values(SESSION_STATE_KIND)) {
    const value = (row as Record<string, unknown> | undefined)?.[kind];
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
      throw new Error(`сверка состояния серверного соединения: колонка ${kind} не прочитана`);
    }
    state[kind] = value;
  }
  return state as SessionState;
}
