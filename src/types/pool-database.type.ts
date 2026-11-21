/**
 * База Drizzle над пулом pg — описана СТРУКТУРНО, а не типом `NodePgDatabase`.
 *
 * Классы Drizzle несут protected-поля, и TypeScript сравнивает их по
 * идентичности файла. Компилятор, не сводящий симлинки pnpm к одному пути
 * (ts-jest, если он прогоняет установленные пакеты через себя), видит
 * drizzle-orm проекта и drizzle-orm пакета двумя разными модулями, и
 * `drizzle(pool)` проекта перестаёт подходить к параметру пакета — при том что
 * `tsc` проекта его принимает. Пакету нужен только `$client`; что это пул,
 * проверяется на входе (`instanceof Pool`).
 */
export interface PoolDatabase {
  readonly $client: unknown;
}
