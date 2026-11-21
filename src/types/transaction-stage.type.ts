import type { TRANSACTION_STAGE } from '../constants/transaction-stage.constant';

/** Где упала транзакция: команда BEGIN, работа вызывающего или COMMIT. */
export type TransactionStage = (typeof TRANSACTION_STAGE)[keyof typeof TRANSACTION_STAGE];
