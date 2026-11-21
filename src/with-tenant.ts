import { sql } from 'drizzle-orm';

import { SETTING_NAME_PATTERN } from './constants/setting-name.constant';
import { TRANSACTION_DEFAULTS } from './constants/transaction-defaults.constant';
import { safeText } from './safe-text';
import { textDefect } from './text-defect';
import type { SqlExecutor } from './types/sql-executor.type';
import type { TransactionHandle } from './types/transaction-handle.type';

/**
 * Контекст арендатора для политик RLS — на ТЕКУЩУЮ транзакцию:
 * `set_config(setting, tenantId, true)`. Обычный `SET` остался бы на
 * соединении пула и уехал бы следующему владельцу (под пулером в transaction
 * mode — соседнему клиенту): запрос без контекста видел бы чужие строки.
 * Пустой идентификатор — отказ: политика `tenant_id = current_setting(…)` на
 * пустой строке ничего не ограничивает так, как ожидает вызывающий.
 *
 * Нужна транзакция (`rollback` — то, что отличает её от корневого клиента):
 * на корневом клиенте `set_config(…, true)` кончился бы вместе со своим
 * оператором, и запросы следом шли бы без контекста. Идентификатор с NUL или
 * непарным суррогатом — `RangeError` до запроса: первый сервер отверг бы
 * посреди транзакции вызывающего, второй драйвер молча заменил бы на U+FFFD —
 * и два разных арендатора совпали бы.
 *
 * Тот же контекст без лишнего запроса — опция `localSettings` транзакции.
 */
export async function withTenant(
  tx: SqlExecutor & TransactionHandle,
  tenantId: string,
  setting: string = TRANSACTION_DEFAULTS.TENANT_SETTING,
): Promise<void> {
  if (typeof (tx as { rollback?: unknown } | null | undefined)?.rollback !== 'function') {
    throw new Error(
      'withTenant: нужна транзакция (tx работы transactionKeepingFailure), а не корневой клиент — ' +
        'контекст на транзакцию корневому клиенту не задать',
    );
  }
  if (typeof tenantId !== 'string' || tenantId.trim() === '') {
    throw new Error('withTenant: идентификатор арендатора пуст — контекст RLS не задаётся пустым');
  }
  const defect = textDefect(tenantId);
  if (defect !== undefined) {
    throw new RangeError(`withTenant: идентификатор арендатора ${defect}`);
  }
  if (typeof setting !== 'string' || !SETTING_NAME_PATTERN.test(setting) || !setting.includes('.')) {
    throw new Error(
      `withTenant: параметр «${safeText(setting)}» — вида префикс.имя или префикс.часть.имя (свой параметр Postgres)`,
    );
  }
  await tx.execute(sql`SELECT set_config(${setting}, ${tenantId}, true)`);
}
