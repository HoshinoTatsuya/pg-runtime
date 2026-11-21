import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Карта exports — граница API: файл dist вне неё недоступен потребителю.
 * Каждый вход ведёт в существующий модуль исходников, typesVersions зеркалит
 * подпути для moduleResolution node10 (он exports не читает), а вход корня
 * совпадает с main/types для тех, кто читает только их.
 */
const ROOT = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  main: string;
  types: string;
  exports: Record<string, string | Conditions | { import: Conditions; require: Conditions }>;
  typesVersions?: Record<string, Record<string, string[]>>;
};
const SUBPATHS: readonly string[] = [];

interface Conditions {
  types: string;
  default: string;
}

/** Условия входа: одни (`types`/`default`) или раздельные для import (`.d.mts`) и require (`.d.ts`). */
const conditionsOf = (target: unknown): Conditions[] => {
  if (typeof target !== 'object' || target === null) {
    throw new Error(`вход без условий: ${String(target)}`);
  }
  const record = target as Record<string, Conditions>;
  return 'import' in record
    ? [record['import'] as Conditions, record['require'] as Conditions]
    : [target as Conditions];
};

describe('карта exports пакета', () => {
  it('входы — ровно корень, объявленные подпути и package.json', () => {
    expect(Object.keys(manifest.exports).sort()).toEqual(
      ['.', './package.json', ...SUBPATHS.map((name) => `./${name}`)].sort(),
    );
  });

  it('каждый вход ведёт в существующий модуль исходников; корень совпадает с main/types', () => {
    const targets = Object.entries(manifest.exports).filter(([key]) => key !== './package.json');
    for (const [, target] of targets) {
      for (const conditions of conditionsOf(target)) {
        expect(conditions.types.replace(/\.d\.m?ts$/, '')).toBe(conditions.default.replace(/\.js$/, ''));
        expect(
          existsSync(join(ROOT, conditions.default.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts'))),
        ).toBe(true);
      }
    }
    const root = conditionsOf(manifest.exports['.']);
    expect(root[root.length - 1]).toEqual({ types: manifest.types, default: manifest.main });
    expect(targets.length).toBe(1 + SUBPATHS.length);
  });

  it('ESM-потребителю — свои декларации .d.mts по условию import, CJS — .d.ts по require', () => {
    // Пакет "type": "commonjs": без .d.mts ESM-потребитель читал .d.ts, drizzle из
    // них резолвился в .d.cts, а у потребителя — в .d.ts, и withTenant(tx) давал
    // TS2345. Сами .d.mts собирает scripts/emit-esm-types.cjs; доходят ли они до
    // потребителя — проверяет scripts/consumer-matrix.sh.
    const targets = Object.entries(manifest.exports).filter(([key]) => key !== './package.json');
    const split = targets.filter(
      ([, target]) =>
        typeof target === 'object' && target !== null && 'import' in target && 'require' in target,
    );
    expect(split.map(([key]) => key)).toEqual(targets.map(([key]) => key));
    for (const [, target] of split) {
      const [esm, cjs] = conditionsOf(target);
      expect(esm?.types).toMatch(/\.d\.mts$/);
      expect(cjs?.types).toMatch(/[^m]\.d\.ts$/);
      expect(esm?.default).toBe(cjs?.default);
    }
  });

  it('typesVersions зеркалит подпути', () => {
    const mirrored = manifest.typesVersions?.['*'] ?? {};
    expect(Object.keys(mirrored).sort()).toEqual([...SUBPATHS].sort());
    for (const name of SUBPATHS) {
      const conditions = conditionsOf(manifest.exports[`./${name}`]);
      expect(mirrored[name]).toEqual([conditions[conditions.length - 1]?.types]);
    }
  });
});
