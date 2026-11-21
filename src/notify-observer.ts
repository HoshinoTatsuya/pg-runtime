/** Вызов наблюдателя: его отказ не меняет исход транзакции (метрика не должна ронять запись). */
export function notifyObserver<E>(callback: ((event: E) => void) | undefined, event: E): void {
  if (callback === undefined) {
    return;
  }
  try {
    callback(event);
  } catch {
    // Наблюдатель — не часть транзакции.
  }
}
