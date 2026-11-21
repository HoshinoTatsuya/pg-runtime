import type { TransactionStage } from './transaction-stage.type';

/** Где и чем отказала попытка: стадия и отказ ДО `wrapFailure` — для классификации повтора. */
export interface AttemptFailure {
  stage: TransactionStage;
  error: unknown;
}
