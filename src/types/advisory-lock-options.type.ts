export interface AdvisoryLockOptions {
  /** Потолок ожидания лока, мс (целое > 0): дольше — `AdvisoryLockTimeoutError`, работа не запускается. */
  readonly timeoutMs: number;
  /** Интервал опроса лока, мс; по умолчанию `TRANSACTION_DEFAULTS.ADVISORY_LOCK_POLL_MS`. */
  readonly pollMs?: number;
  /** Прерывает ожидание соединения и лока (наружу `signal.reason`). */
  readonly signal?: AbortSignal;
  /**
   * Соединение идёт через пулер в transaction mode. `withSessionAdvisoryLock`
   * под ним — отказ `PoolerIncompatibleError` до соединения: сессионный лок
   * остался бы на серверном соединении пулера навсегда (снятие уходит другому
   * серверному соединению). `withAdvisoryLock` — защита транзакции
   * (`TransactionOptions.transactionPooler`).
   */
  readonly transactionPooler?: boolean;
}
