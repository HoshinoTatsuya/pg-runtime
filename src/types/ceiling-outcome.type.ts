/** Исход служебного запроса (ROLLBACK, уборка сессии): ответ с кодами предупреждений или отказ. */
export type CeilingOutcome =
  | { readonly ok: true; readonly notices: readonly string[]; readonly result?: unknown }
  | { readonly ok: false; readonly error: Error };
