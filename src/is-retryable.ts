import { CommitOutcomeUnknownError } from './commit-outcome-unknown.error';
import { RETRY_REASON } from './constants/retry-reason.constant';
import { RETRY_REASON_SQLSTATE } from './constants/retry-reason-sqlstate.constant';

import { TRANSACTION_STAGE } from './constants/transaction-stage.constant';
import { errorChain } from './error-chain';
import { isTransientConnectionFailure } from './is-transient-connection-failure';
import { ManualTransactionControlError } from './manual-transaction-control.error';
import { SessionStateLeakError } from './session-state-leak.error';
import { TransactionCallbackError } from './transaction-callback.error';
import type { ResolvedRetry } from './types/resolved-retry.type';
import type { TransactionStage } from './types/transaction-stage.type';

/**
 * Можно ли повторить попытку. SQLSTATE ищется в отказе и в его `cause`
 * (wrapFailure, DrizzleQueryError). Исход COMMIT неизвестен — не повторяется
 * никогда: повтор мог бы задвоить зафиксированное; работа сама завершила
 * транзакцию (`ManualTransactionControlError`) — тоже. Состояние серверного
 * соединения под пулером изменено — тоже: работа могла зафиксироваться, а
 * повтор оставил бы то же состояние ещё раз.
 */
export function isRetryable(error: unknown, stage: TransactionStage, retry: ResolvedRetry): boolean {
  const chain = errorChain(error);
  if (
    chain.some(
      (link) =>
        link instanceof CommitOutcomeUnknownError ||
        link instanceof SessionStateLeakError ||
        link instanceof ManualTransactionControlError,
    )
  ) {
    return false;
  }
  const codes = new Set(
    [...retry.reasons].map((reason) => RETRY_REASON_SQLSTATE[reason]).filter((code) => code !== undefined),
  );
  if (chain.some((link) => codes.has((link as { code?: unknown }).code as string))) {
    return true;
  }
  if (
    retry.reasons.has(RETRY_REASON.connectionBeforeWork) &&
    stage === TRANSACTION_STAGE.begin &&
    isTransientConnectionFailure(error)
  ) {
    return true;
  }
  if (retry.when === undefined) {
    return false;
  }
  let decision: unknown;
  try {
    decision = retry.when(error, stage);
  } catch (callbackError) {
    // Бросок колбэка не должен заменить отказ попытки: тот уходит в cause.
    throw new TransactionCallbackError('retry.when', callbackError, error);
  }
  return decision === true;
}
