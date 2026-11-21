import { SESSION_RESET_SQL } from './constants/session-reset.constant';
import { SESSION_STATE_KIND } from './constants/session-state-kind.constant';
import { dollarQuoted } from './dollar-quoted';
import { probeAssignment } from './probe-assignment';
import { quotedIdentifier } from './quoted-identifier';
import type { SessionState } from './types/session-state.type';

/**
 * Запрос уборки сессии, возвращающий соединение к базовой линии `connect`:
 * `SESSION_RESET_SQL` (сносит всё сессионное, в том числе заданное на connect) и
 * следом — восстановление снимка, взятого `SESSION_PROBE_SQL` в первой
 * транзакции соединения: параметры Postgres (`set_config(…, false)`), сессионная
 * роль и `SET ROLE`, подписки `LISTEN`. Порядок: параметры — пока сессия под
 * исходным пользователем (у него прав на их установку больше всего), затем
 * `session_authorization`, затем `role` (смена пользователя сессии снимает роль).
 * Всё одним простым запросом — одной неявной транзакцией: `UNLISTEN *` и
 * повторный `LISTEN` применяются вместе при её фиксации, уведомления канала
 * между ними не теряются.
 *
 * Временные объекты, курсоры WITH HOLD и сессионные advisory-локи вернуть
 * нельзя (содержимое таблицы, позиция курсора, владение локом): если они есть
 * в снимке — отказ, а не тихая потеря. Подготовленные операторы уборка не
 * снимает — они переживают её и так.
 */
export function sessionResetSql(baseline: SessionState): string {
  const unrestorable = [
    SESSION_STATE_KIND.temporaryObject,
    SESSION_STATE_KIND.holdableCursor,
    SESSION_STATE_KIND.advisoryLock,
  ].flatMap((kind) => baseline[kind].map((item) => `${kind}: ${item}`));
  if (unrestorable.length > 0) {
    throw new Error(
      `transactionKeepingFailure: resetSession не вернёт соединение к состоянию после connect — на нём уже ` +
        `есть то, что уборка снимет безвозвратно (${unrestorable.join('; ')}). Создавайте это в транзакции ` +
        `(ON COMMIT DROP, pg_advisory_xact_lock) или задайте sessionBaseline: 'defaults'`,
    );
  }
  const statements = [SESSION_RESET_SQL];
  const settings = baseline[SESSION_STATE_KIND.setting].map(probeAssignment);
  if (settings.length > 0) {
    statements.push(
      `SELECT ${settings
        .map(([name, value]) => `pg_catalog.set_config(${dollarQuoted(name)}, ${dollarQuoted(value)}, false)`)
        .join(', ')}`,
    );
  }
  const role = new Map(baseline[SESSION_STATE_KIND.role].map(probeAssignment));
  const sessionUser = role.get('session_user');
  const currentUser = role.get('current_user');
  if (sessionUser === undefined || currentUser === undefined || role.size !== 2) {
    throw new Error('снимок состояния соединения не разобран: нет session_user или current_user');
  }
  // После `SET SESSION AUTHORIZATION DEFAULT` пользователь сессии — вошедший;
  // менять его, только если на connect его сменили.
  statements.push(
    `SELECT pg_catalog.set_config('session_authorization', ${dollarQuoted(sessionUser)}, false) ` +
      `WHERE session_user OPERATOR(pg_catalog.<>) ${dollarQuoted(sessionUser)}`,
  );
  if (currentUser !== sessionUser) {
    statements.push(`SELECT pg_catalog.set_config('role', ${dollarQuoted(currentUser)}, false)`);
  }
  for (const channel of baseline[SESSION_STATE_KIND.listenChannel]) {
    statements.push(`LISTEN ${quotedIdentifier(channel)}`);
  }
  return statements.join('; ');
}
