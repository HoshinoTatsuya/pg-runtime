import type { SESSION_STATE_KIND } from '../constants/session-state-kind.constant';

/** Вид состояния серверного соединения (`SESSION_STATE_KIND`). */
export type SessionStateKind = (typeof SESSION_STATE_KIND)[keyof typeof SESSION_STATE_KIND];
