import type { TransactionStage } from './transaction-stage.type';

/**
 * Наблюдение за пулом и попытками — для метрик (гистограмма ожидания
 * соединения, счётчики уничтоженных соединений и повторов). «База медленная»
 * и «пул мал» без этого неотличимы. Отказ наблюдателя транзакцию не роняет:
 * он проглатывается.
 */
export interface TransactionObserver {
  /** Соединение пула получено; `waitMs` — сколько ждали (очередь пула + установка соединения). */
  readonly connectionAcquired?: (event: { readonly waitMs: number }) => void;
  /** Соединение уничтожено, а не возвращено в пул: обрыв, непрошедший откат, разрыв сервером. */
  readonly connectionDestroyed?: (event: { readonly stage: TransactionStage; readonly error: Error }) => void;
  /** Попытка отказала; `willRetry` — будет ли следующая. */
  readonly attemptFailed?: (event: {
    readonly attempt: number;
    readonly stage: TransactionStage;
    readonly error: unknown;
    readonly willRetry: boolean;
  }) => void;
}
