import type { SessionStateKind } from './session-state-kind.type';

/**
 * Изменение состояния серверного соединения за транзакцию: `appeared` —
 * появилось (параметр — с новым значением), `disappeared` — пропало (снято
 * чужое: `UNLISTEN *`, `CLOSE ALL`, `pg_advisory_unlock_all()`, `RESET`).
 */
export interface SessionStateChange {
  readonly kind: SessionStateKind;
  readonly item: string;
  readonly change: 'appeared' | 'disappeared';
}
