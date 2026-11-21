import { sessionStateChanges } from './session-state-changes';
import { SessionStateLeakError } from './session-state-leak.error';
import { sessionStateOf } from './session-state-of';
import { toError } from './to-error';
import type { SessionState } from './types/session-state.type';

/**
 * Итог сверки после конца транзакции: `answer` — ответ на «COMMIT|ROLLBACK;
 * сверка» (второй результат — строка сверки) или отказ сверки. Изменилось
 * состояние или сверка не прочитана — `SessionStateLeakError`, иначе ничего.
 */
export function sessionLeak(
  before: SessionState,
  answer: { readonly result: unknown } | { readonly error: Error },
  committed: boolean,
  cause: unknown,
): SessionStateLeakError | undefined {
  if ('error' in answer) {
    return new SessionStateLeakError([], committed, answer.error, cause);
  }
  let after: SessionState;
  try {
    after = sessionStateOf(
      (answer.result as ReadonlyArray<{ rows?: unknown[] }> | undefined)?.[1]?.rows?.[0],
    );
  } catch (error) {
    return new SessionStateLeakError([], committed, toError(error), cause);
  }
  const changes = sessionStateChanges(before, after);
  return changes.length > 0 ? new SessionStateLeakError(changes, committed, undefined, cause) : undefined;
}
