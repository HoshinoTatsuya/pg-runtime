import type { TransactionHandle } from './transaction-handle.type';

/**
 * Тип транзакции базы ПОТРЕБИТЕЛЯ — из её собственного `transaction`, а не
 * класс drizzle из деклараций пакета. Класс пакета резолвится по его условию
 * (`require` → `.d.cts`), потребитель на bundler/nodenext-ESM или TypeScript 6
 * с `module: commonjs` — по `import` (`.d.ts`): два несовместимых класса, и
 * `tx.insert(таблица потребителя)` не компилировался (TS2345) там, где работа
 * не аннотирована. База без `transaction` — только `TransactionHandle`.
 */
export type TransactionOf<Db> = Db extends {
  transaction(work: (tx: infer Tx) => Promise<unknown>, ...rest: never[]): unknown;
}
  ? Tx extends TransactionHandle
    ? Tx
    : TransactionHandle
  : TransactionHandle;
