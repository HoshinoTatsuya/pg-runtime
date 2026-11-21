import type { SessionStateChange } from './types/session-state-change.type';

/**
 * Под пулером в transaction mode (`transactionPooler`) транзакция оставила на
 * серверном соединении состояние, которое переживает её (`changes`), — или
 * сверка этого состояния не выполнилась (`verified: false`, причина —
 * `probeError`). Следующий клиент пулера получит это серверное соединение
 * как есть: чужой `search_path`, роль, временную таблицу, лок.
 *
 * Сверка не зависит от текста запросов: она ловит то, что фильтр текста не
 * видит (DO-блок, функция, `EXECUTE`). Бросается ПОСЛЕ конца транзакции:
 * `committed` — работа зафиксирована нашим COMMIT (повтор задвоил бы её; повтор
 * не повторяет эту ошибку никогда). Собственный отказ транзакции (работы,
 * `CommitRolledBackError`, `ManualTransactionControlError`) — в `cause`.
 */
export class SessionStateLeakError extends Error {
  public override readonly name = 'SessionStateLeakError';

  public readonly verified: boolean;

  public constructor(
    public readonly changes: readonly SessionStateChange[],
    public readonly committed: boolean,
    public readonly probeError: Error | undefined,
    cause: unknown,
  ) {
    const what =
      probeError === undefined
        ? `транзакция изменила состояние серверного соединения: ${changes
            .map(({ kind, item, change }) => `${change === 'appeared' ? '+' : '−'} ${kind}: ${item}`)
            .join('; ')}`
        : `состояние серверного соединения после транзакции не проверено: ${probeError.message}`;
    super(
      `под пулером в transaction mode ${what} — его получит следующий клиент пулера` +
        (committed ? ' (работа зафиксирована)' : ' (работа не зафиксирована)'),
      cause === undefined ? undefined : { cause },
    );
    this.verified = probeError === undefined;
  }
}
