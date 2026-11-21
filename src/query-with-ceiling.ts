import type { PoolClient } from 'pg';

import { destroyConnection } from './destroy-connection';
import { toError } from './to-error';
import { trackedQuery } from './tracked-query';
import type { CeilingOutcome } from './types/ceiling-outcome.type';

/**
 * Служебный запрос с потолком: не ответил за `ceilingMs` — сокет закрывается
 * (`onDestroy` зовётся ДО закрытия: разрыв, который мы устроили сами, —
 * не разрыв сервером), и исход — отказ. Коды предупреждений (`notice`),
 * пришедших за время запроса, — в исходе: ROLLBACK вне транзакции отвечает 25P01.
 * С `completed` — запрос из нескольких операторов с записью тегов завершённых
 * (`trackedQuery`); ответ сервера — в `result` исхода. С `values` — запрос
 * одного оператора с параметрами `$n`.
 */
export async function queryWithCeiling(
  client: PoolClient,
  text: string,
  ceilingMs: number,
  onDestroy: () => void,
  completed?: string[],
  values?: readonly unknown[],
): Promise<CeilingOutcome> {
  const notices: string[] = [];
  const onNotice = (notice: { code?: string | undefined }): void => {
    if (typeof notice.code === 'string') {
      notices.push(notice.code);
    }
  };
  client.on('notice', onNotice);
  let timer: NodeJS.Timeout | undefined;
  const pending: Promise<unknown> =
    completed === undefined
      ? values === undefined
        ? client.query(text)
        : client.query(text, [...values])
      : trackedQuery(client, text, completed);
  try {
    const silent = new Promise<'silent'>((resolve) => {
      timer = setTimeout(() => resolve('silent'), ceilingMs);
    });
    const answered = await Promise.race([pending.then((result) => ({ result })), silent]);
    if (answered === 'silent') {
      // Отказ запроса после закрытия сокета — ожидаемый, его никто не ждёт.
      pending.catch(() => undefined);
      onDestroy();
      destroyConnection(client);
      return {
        ok: false,
        error: new Error(
          `${completed === undefined ? text : text.split(';')[0]}: нет ответа за ${ceilingMs} мс — соединение уничтожено`,
        ),
      };
    }
    return { ok: true, notices, result: answered.result };
  } catch (error) {
    return { ok: false, error: toError(error) };
  } finally {
    clearTimeout(timer);
    client.off('notice', onNotice);
  }
}
