/**
 * Функции, оставляющие состояние серверного соединения после транзакции, —
 * в любом месте кода запроса (`sqlCode`): `pg_catalog.` и кавычки имени не прячут.
 * `set_config` — отдельно (`setConfigViolations`): там решает третий аргумент.
 */
export const POOLER_SESSION_FUNCTIONS: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
  [/\bpg_(?:try_)?advisory_(?:un)?lock(?:_shared)?\s*\(/i, 'сессионный advisory-лок (нужен *_xact_lock)'],
  [/\bpg_advisory_unlock_all\s*\(/i, 'pg_advisory_unlock_all снимает сессионные локи серверного соединения'],
  [/\bdblink_connect(?:_u)?\s*\(/i, 'dblink_connect — соединение dblink живёт в серверном соединении'],
  [
    /\bpg_replication_origin_session_(?:setup|reset)\s*\(/i,
    'источник репликации сессии — состояние серверного соединения',
  ],
] as const);
