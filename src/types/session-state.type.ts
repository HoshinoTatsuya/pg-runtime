import type { SessionStateKind } from './session-state-kind.type';

/** Снимок состояния серверного соединения: по каждому виду — отсортированный список. */
export type SessionState = Readonly<Record<SessionStateKind, readonly string[]>>;
