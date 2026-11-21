import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Код в README — только цитаты файлов `examples/*.ts`, а те проходят typecheck
 * против настоящего API (`tsconfig.examples.json`, часть `pnpm typecheck`).
 * Блок ```ts без отметки `<!-- example: examples/<файл>.ts -->` перед ним — нарушение:
 * его никто не компилирует, и он разойдётся с API первым.
 */
const ROOT = join(__dirname, '..');
const EXAMPLES = readdirSync(join(ROOT, 'examples'))
  .filter((name) => name.endsWith('.ts'))
  .map((name) => `examples/${name}`)
  .sort();

describe.each(['README.md', 'README.ru.md'])('примеры кода в %s', (readme) => {
  const text = readFileSync(join(ROOT, readme), 'utf8');
  const blocks = [...text.matchAll(/(?:<!-- example: (examples\/[\w.-]+\.ts) -->\n)?```ts\n([\s\S]*?)```/g)];

  it('выборка не выродилась: примеры есть, и README их цитирует', () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(3);
    expect(blocks.length).toBeGreaterThanOrEqual(EXAMPLES.length);
  });

  it('каждый блок ```ts — цитата файла из examples/', () => {
    expect(blocks.filter((block) => block[1] === undefined).map((block) => block[2]?.slice(0, 80))).toEqual(
      [],
    );
  });

  it('каждый файл examples/ процитирован', () => {
    expect([...new Set(blocks.map((block) => block[1]))].sort()).toEqual(EXAMPLES);
  });

  it('цитата совпадает с файлом символ в символ', () => {
    for (const [, file, code] of blocks) {
      expect({ file, code }).toEqual({ file, code: readFileSync(join(ROOT, file as string), 'utf8') });
    }
  });
});
