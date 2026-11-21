/** Ключ advisory-лока для запроса: выражение от `$1`, значение параметра и подпись для сообщений. */
export interface AdvisoryLockKeySql {
  readonly expression: string;
  readonly value: string;
  readonly label: string;
}
