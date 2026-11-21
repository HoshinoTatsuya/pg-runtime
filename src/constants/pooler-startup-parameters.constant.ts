/**
 * Параметры старта сессии, которые пулер в transaction mode не передаёт
 * серверу или отвергает (PgBouncer: «unsupported startup parameter», если их
 * нет в ignore_startup_parameters), а с ignore — молча теряет: потолок,
 * заданный так, не действует.
 */
export const POOLER_STARTUP_PARAMETERS: readonly string[] = Object.freeze([
  'options',
  'statement_timeout',
  'lock_timeout',
  'idle_in_transaction_session_timeout',
]);
