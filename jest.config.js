/**
 * Полный набор запускается ТОЛЬКО через `pnpm test` (jest-groups: группы
 * ≤300 тестов, ≤2 воркера, последовательно). Прямой `jest` — для одного-двух
 * файлов и тоже с --maxWorkers=2.
 */
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  // Примеры README импортируют пакет по имени, как потребитель (src/examples.db.spec.ts).
  moduleNameMapper: { '^@hoshinotatsuya/pg-runtime$': '<rootDir>/src/index.ts' },
  maxWorkers: 2,
  clearMocks: true,
  restoreMocks: true,
};
