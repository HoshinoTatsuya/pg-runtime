/**
 * Что оставила работа на соединении: транзакции нет, транзакция открыта
 * (в том числе прервана отказом — 25P02), соединение не ответило (обрыв или
 * потолок запроса: исход не узнать, соединение уничтожается) или сервер
 * отказал проверке иначе — «не смогли определить» считается отказом.
 */
export type OpenTransactionState =
  | { readonly state: 'closed' }
  | { readonly state: 'open' }
  | { readonly state: 'unreachable'; readonly error: Error }
  | { readonly state: 'failed'; readonly error: Error };
