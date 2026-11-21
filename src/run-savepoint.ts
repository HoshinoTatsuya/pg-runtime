import { sql } from 'drizzle-orm';
import { NodePgSession, NodePgTransaction } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import { OUTER_ONLY_OPTIONS } from './constants/outer-only-options.constant';
import { TRANSACTION_STAGE } from './constants/transaction-stage.constant';
import { guardedClient } from './guarded-client';
import { removeWorkListeners } from './remove-work-listeners';
import { TransactionCallbackError } from './transaction-callback.error';
import { TRANSACTION_CONTEXT } from './transaction-context';
import type { TransactionFrame } from './types/transaction-frame.type';
import type { TransactionOptions } from './types/transaction-options.type';

/**
 * Вложенный вызов как точка сохранения внешней транзакции (SAVEPOINT /
 * RELEASE / ROLLBACK TO, как `tx.transaction` drizzle). Работа получает
 * транзакцию точки сохранения и соединение внешней; отказ работы откатывает
 * только её. `transactionPooler: true` — только если он задан и у внешней
 * (защита стоит на её соединении); `observer` не вызывается: соединение,
 * попытки и его уничтожение — внешней транзакции, их видит её наблюдатель.
 *
 * Сессия точки сохранения — СВОЯ, над соединением с защитой конца вложенной
 * работы: запрос, переживший её (таймер, забытый await), — через сырой клиент
 * или через `tx.execute` вложенной — `TransactionClientMisuseError`, а не
 * запись во внешнюю транзакцию после отката своей точки сохранения.
 * `tx.transaction` drizzle этого не даёт: его вложенная транзакция идёт по
 * сессии внешней.
 */
export async function runSavepoint<T, Tx>(
  frame: TransactionFrame,
  work: (tx: Tx, client: PoolClient) => Promise<T>,
  options: TransactionOptions,
): Promise<T> {
  const conflicting = OUTER_ONLY_OPTIONS.filter((name) => options[name] !== undefined);
  if (conflicting.length > 0) {
    throw new Error(
      `transactionKeepingFailure: под точкой сохранения опции ${conflicting.join(', ')} не действуют — ` +
        'они принадлежат внешней транзакции',
    );
  }
  if (options.transactionPooler === true && !frame.transactionPooler) {
    // Защита пулера стоит на соединении внешней транзакции: вложенный вызов её
    // не включит, а молча пройти — значит обещать проверку, которой нет.
    throw new Error(
      'transactionKeepingFailure: под точкой сохранения transactionPooler: true, а внешняя транзакция идёт без ' +
        'него — защита пулера ставится на соединение внешней транзакции; задайте transactionPooler у внешней',
    );
  }
  options.signal?.throwIfAborted();
  try {
    const depth = frame.depth + 1;
    const name = `sp${depth}`;
    // Поверх соединения внешней: её защита (release, end, пулер, её конец) остаётся.
    const client = guardedClient(frame.client, () => child.ended, false);
    const { dialect, schema } = frame.source;
    const inner = new NodePgTransaction(
      dialect,
      new NodePgSession(client, dialect, schema, frame.source.options),
      schema,
      depth,
    );
    const child: TransactionFrame = {
      pool: frame.pool,
      transaction: inner,
      client,
      source: frame.source,
      depth,
      transactionPooler: frame.transactionPooler,
      ended: false,
    };
    // Команды точки сохранения — через транзакцию внешней: после конца
    // вложенной её соединение уже закрыто для запросов.
    await frame.transaction.execute(sql.raw(`savepoint ${name}`));
    let result: T;
    try {
      result = await TRANSACTION_CONTEXT.run([...(TRANSACTION_CONTEXT.getStore() ?? []), child], () =>
        work(inner as Tx, client),
      );
    } catch (error) {
      child.ended = true;
      await frame.transaction.execute(sql.raw(`rollback to savepoint ${name}`));
      throw error;
    } finally {
      child.ended = true;
      removeWorkListeners(client);
    }
    await frame.transaction.execute(sql.raw(`release savepoint ${name}`));
    return result;
  } catch (error) {
    if (options.wrapFailure === undefined) {
      throw error;
    }
    let wrapped: unknown;
    try {
      wrapped = options.wrapFailure(TRANSACTION_STAGE.work, error);
    } catch (callbackError) {
      wrapped = new TransactionCallbackError('wrapFailure', callbackError, error);
    }
    throw wrapped;
  }
}
