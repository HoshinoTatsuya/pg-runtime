import { SETTING_NAME_PATTERN } from './constants/setting-name.constant';
import { safeText } from './safe-text';
import type { TransactionOptions } from './types/transaction-options.type';

/**
 * Имена `resetAppSettings`, проверенные до соединения: массив своих параметров
 * вида `префикс.имя`. Параметр Postgres без префикса (`work_mem`, `role`,
 * `search_path`) — отказ: сброс роли или пути поиска посреди уборки — другая
 * операция, и её делает `resetSession`, а не эта опция.
 */
export function appSettingNames(options: TransactionOptions): readonly string[] {
  const names: unknown = options.resetAppSettings;
  if (names === undefined) {
    return [];
  }
  if (!Array.isArray(names)) {
    throw new Error('transactionKeepingFailure: resetAppSettings — массив имён своих параметров');
  }
  for (const name of names) {
    if (typeof name !== 'string' || !SETTING_NAME_PATTERN.test(name) || !name.includes('.')) {
      throw new Error(
        `transactionKeepingFailure: resetAppSettings — «${safeText(name)}» не имя своего параметра (префикс.имя)`,
      );
    }
  }
  return [...names] as string[];
}
