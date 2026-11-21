import { RETRY_REASON } from './constants/retry-reason.constant';
import { RETRY_REASON_SQLSTATE } from './constants/retry-reason-sqlstate.constant';

/**
 * Advisory-лок не взят за `timeoutMs`: его держит другая сессия. Работа не
 * запускалась. `code` — 55P03 (lock_not_available), как у истёкшего
 * `lock_timeout`: это та же причина отказа, и `retry.on: ['lock-timeout']`
 * у `withAdvisoryLock` повторяет транзакцию вместе со взятием лока.
 */
export class AdvisoryLockTimeoutError extends Error {
  public override readonly name = 'AdvisoryLockTimeoutError';
  public readonly code = RETRY_REASON_SQLSTATE[RETRY_REASON.lockTimeout] as string;

  public constructor(
    public readonly key: string,
    public readonly timeoutMs: number,
  ) {
    super(`advisory-лок ${key} не взят за ${timeoutMs} мс: его держит другая сессия; работа не запускалась`);
  }
}
