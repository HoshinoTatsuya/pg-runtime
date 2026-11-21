import { SESSION_STATE_KIND } from './constants/session-state-kind.constant';
import type { SessionState } from './types/session-state.type';
import type { SessionStateChange } from './types/session-state-change.type';

/** Что транзакция изменила в состоянии серверного соединения: разница двух снимков, по видам. */
export function sessionStateChanges(before: SessionState, after: SessionState): SessionStateChange[] {
  const changes: SessionStateChange[] = [];
  for (const kind of Object.values(SESSION_STATE_KIND)) {
    const was = new Set(before[kind]);
    const now = new Set(after[kind]);
    for (const item of now) {
      if (!was.has(item)) {
        changes.push({ kind, item, change: 'appeared' });
      }
    }
    for (const item of was) {
      if (!now.has(item)) {
        changes.push({ kind, item, change: 'disappeared' });
      }
    }
  }
  return changes;
}
