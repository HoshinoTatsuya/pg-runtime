import { type PoolClient, Query } from 'pg';

/**
 * Запрос из нескольких операторов (простой протокол) с записью тегов
 * завершённых операторов в `completed` (`COMMIT`, `ROLLBACK`, `SELECT 1`) —
 * в том числе когда запрос в целом отказал. Так отказ сверки ПОСЛЕ COMMIT
 * отличается от отказа самого COMMIT: у первого тег COMMIT уже есть.
 *
 * Класс запроса берётся у самого соединения (`Client.Query` его копии pg), а
 * не из копии пакета: в монорепозитории копий pg может быть две.
 */
export function trackedQuery(client: PoolClient, text: string, completed: string[]): Promise<unknown> {
  const QueryClass = (client.constructor as { Query?: typeof Query }).Query ?? Query;
  return new Promise((resolve, reject) => {
    const query = new QueryClass(text, (error: Error | undefined, result: unknown) =>
      error === undefined || error === null ? resolve(result) : reject(error),
    );
    const handle = query as unknown as {
      handleCommandComplete: (message: { text?: string }, connection: unknown) => void;
    };
    const original = handle.handleCommandComplete.bind(query);
    handle.handleCommandComplete = (message, connection) => {
      completed.push(String(message.text ?? ''));
      original(message, connection);
    };
    client.query(query);
  });
}
