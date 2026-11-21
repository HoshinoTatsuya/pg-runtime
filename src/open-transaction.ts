import type { PoolClient } from 'pg';

import { IN_FAILED_TRANSACTION } from './constants/in-failed-transaction.constant';
import { OPEN_TRANSACTION_PROBE_SQL } from './constants/open-transaction-probe.constant';
import { TRANSACTION_DEFAULTS } from './constants/transaction-defaults.constant';
import { isConnectionFailure } from './is-connection-failure';
import { queryWithCeiling } from './query-with-ceiling';
import type { OpenTransactionState } from './types/open-transaction-state.type';

/**
 * Проверка соединения после работы вне транзакции пакета: открыта ли на нём
 * транзакция. Отдельным запросом без параметров (`OPEN_TRANSACTION_PROBE_SQL`)
 * и с потолком `ROLLBACK_TIMEOUT_MS`: не ответил — соединение уничтожено
 * (`onDestroy` до закрытия сокета).
 */
export async function openTransaction(
  client: PoolClient,
  onDestroy: () => void,
): Promise<OpenTransactionState> {
  const probe = await queryWithCeiling(
    client,
    OPEN_TRANSACTION_PROBE_SQL,
    TRANSACTION_DEFAULTS.ROLLBACK_TIMEOUT_MS,
    onDestroy,
  );
  if (!probe.ok) {
    if ((probe.error as { code?: unknown }).code === IN_FAILED_TRANSACTION) {
      return { state: 'open' };
    }
    return isConnectionFailure(probe.error)
      ? { state: 'unreachable', error: probe.error }
      : { state: 'failed', error: probe.error };
  }
  const inTransaction = (probe.result as { rows?: Array<{ in_tx?: unknown }> }).rows?.[0]?.in_tx;
  if (inTransaction === false) {
    return { state: 'closed' };
  }
  if (inTransaction === true) {
    return { state: 'open' };
  }
  return {
    state: 'failed',
    error: new Error(
      `${OPEN_TRANSACTION_PROBE_SQL}: ответ без логического in_tx — состояние соединения неизвестно`,
    ),
  };
}
