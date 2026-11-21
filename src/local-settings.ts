import { SETTING_NAME_PATTERN } from './constants/setting-name.constant';
import { textDefect } from './text-defect';
import { timeoutMs } from './timeout-ms';
import type { TransactionOptions } from './types/transaction-options.type';

/**
 * Параметры транзакции для одного `set_config(…, true)`: таймауты и свои
 * (`localSettings`). Два параметра с одним именем (таймаут и свой, два своих;
 * регистр не важен — Postgres его не различает) — отказ: какой из двух
 * действует, решал бы порядок в запросе.
 */
export function localSettings(options: TransactionOptions): [string, string][] {
  const settings: [string, string][] = [];
  const add = (name: string, value: number | undefined): void => {
    if (value !== undefined) {
      settings.push([name, `${value}ms`]);
    }
  };
  add('lock_timeout', timeoutMs('lockTimeoutMs', options.lockTimeoutMs));
  add('statement_timeout', timeoutMs('statementTimeoutMs', options.statementTimeoutMs));
  add(
    'idle_in_transaction_session_timeout',
    timeoutMs('idleInTransactionTimeoutMs', options.idleInTransactionTimeoutMs),
  );
  for (const [name, value] of Object.entries(options.localSettings ?? {})) {
    if (!SETTING_NAME_PATTERN.test(name)) {
      throw new Error(`transactionKeepingFailure: localSettings — недопустимое имя параметра «${name}»`);
    }
    if (typeof value !== 'string') {
      throw new Error(`transactionKeepingFailure: localSettings.${name} — строка, получено ${typeof value}`);
    }
    const defect = textDefect(value);
    if (defect !== undefined) {
      throw new RangeError(`transactionKeepingFailure: localSettings.${name} ${defect}`);
    }
    // Postgres сравнивает имена параметров без учёта регистра: `LOCK_TIMEOUT` —
    // тот же lock_timeout, `app.X` — тот же app.x.
    const taken = settings.find(([other]) => other.toLowerCase() === name.toLowerCase());
    if (taken !== undefined) {
      throw new Error(
        `transactionKeepingFailure: localSettings.${name} задан и опцией таймаута или другим своим параметром ` +
          `(${taken[0]}; Postgres не различает регистр имён): какой из двух действует, решал бы порядок в запросе`,
      );
    }
    settings.push([name, value]);
  }
  return settings;
}
