import type { PoolClient } from 'pg';

import { CLIENT_MISUSE } from './constants/client-misuse.constant';
import { WORK_LISTENER_CLEANUPS } from './constants/work-listener-cleanups.constant';
import { PoolerIncompatibleError } from './pooler-incompatible.error';
import { poolerViolations } from './pooler-violations';
import { TransactionClientMisuseError } from './transaction-client-misuse.error';

/**
 * Соединение для работы: `release()` бросает (соединение возвращает только
 * пакет — иначе пул отдал бы его следующему посреди нашей транзакции или с
 * нашим сессионным локом, а наш release в finally упал бы «already released»),
 * `end()` — тоже (соединение закрылось бы мимо пула посреди транзакции), запрос
 * после конца работы — тоже, и по ссылке на `query`, взятой заранее: конец
 * проверяется при вызове, а не только при чтении свойства. Под пулером в
 * transaction mode запрос с сессионным состоянием — `PoolerIncompatibleError`
 * до отправки.
 *
 * Слушатели: работа снимает (`off`, `removeListener`, `removeAllListeners`)
 * только те, что поставила через это же соединение. Обработчик `'error'`
 * пакета (без него разрыв сессии — падение процесса) и его `'notice'` (по
 * нему узнаётся ручное завершение транзакции) снять из работы нельзя.
 * Поставленные работой и не снятые снимает `removeWorkListeners` с концом
 * работы — до возврата соединения в пул.
 *
 * Остальное — методы самого соединения, вызванные на нём же: состояние
 * драйвера не видит обёртки.
 */
export function guardedClient(
  client: PoolClient,
  transactionEnded: () => boolean,
  transactionPooler: boolean,
): PoolClient {
  // Слушатели, поставленные работой: событие → функции в порядке постановки.
  const added = new Map<string | symbol, Array<(...args: unknown[]) => void>>();
  const record = (event: string | symbol, listener: (...args: unknown[]) => void): void => {
    added.set(event, [...(added.get(event) ?? []), listener]);
  };
  const forget = (event: string | symbol, listener: unknown): boolean => {
    const listeners = added.get(event) ?? [];
    const index = listeners.lastIndexOf(listener as (...args: unknown[]) => void);
    if (index === -1) {
      return false;
    }
    listeners.splice(index, 1);
    return true;
  };
  const proxy: PoolClient = new Proxy(client, {
    get(target, property) {
      if (property === 'release' || property === 'end') {
        const misuse = property === 'release' ? CLIENT_MISUSE.release : CLIENT_MISUSE.end;
        return (): never => {
          throw new TransactionClientMisuseError(misuse);
        };
      }
      if (property === 'query' && transactionEnded()) {
        return (): never => {
          throw new TransactionClientMisuseError(CLIENT_MISUSE.afterEnd);
        };
      }
      if (
        property === 'on' ||
        property === 'addListener' ||
        property === 'once' ||
        property === 'prependListener' ||
        property === 'prependOnceListener'
      ) {
        return (event: string | symbol, listener: (...args: unknown[]) => void): PoolClient => {
          (
            target[property] as (name: string | symbol, handler: (...args: unknown[]) => void) => unknown
          ).call(target, event, listener);
          record(event, listener);
          return proxy;
        };
      }
      if (property === 'off' || property === 'removeListener') {
        return (event: string | symbol, listener: (...args: unknown[]) => void): PoolClient => {
          if (forget(event, listener)) {
            target.removeListener(event, listener);
          }
          return proxy;
        };
      }
      if (property === 'removeAllListeners') {
        return (event?: string | symbol): PoolClient => {
          for (const [name, listeners] of added) {
            if (event === undefined || name === event) {
              for (const listener of listeners.splice(0)) {
                target.removeListener(name, listener);
              }
            }
          }
          return proxy;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') {
        return value;
      }
      // Свойство самого экземпляра (подмена, шпион теста) — как есть: привязка
      // давала бы новую функцию на каждое чтение, и `jest.spyOn(client, 'query')`
      // возвращал бы привязанную копию без API шпиона. Методы прототипа —
      // привязанными к соединению: состояние драйвера не видит обёртки.
      const own = Object.hasOwn(target, property);
      const method = (own ? value : value.bind(target)) as (...args: unknown[]) => unknown;
      if (property !== 'query' || (own && !transactionPooler)) {
        return method;
      }
      return (...args: unknown[]): unknown => {
        if (transactionEnded()) {
          throw new TransactionClientMisuseError(CLIENT_MISUSE.afterEnd);
        }
        if (transactionPooler) {
          const problems = poolerViolations(args[0], args[1]);
          if (problems.length > 0) {
            throw new PoolerIncompatibleError(problems);
          }
        }
        return method(...args);
      };
    },
  });
  WORK_LISTENER_CLEANUPS.set(proxy, () => {
    for (const [name, listeners] of added) {
      for (const listener of listeners.splice(0)) {
        client.removeListener(name, listener);
      }
    }
    added.clear();
  });
  return proxy;
}
