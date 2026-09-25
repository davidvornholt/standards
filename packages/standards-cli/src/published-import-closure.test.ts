import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Transpiler } from 'bun';

const packageRoot = resolve(import.meta.dir, '..');
const manifest = JSON.parse(
  readFileSync(join(packageRoot, 'package.json'), 'utf8'),
) as {
  readonly bin: Record<string, string>;
  readonly files: ReadonlyArray<string>;
};

const importClosure = (): Array<string> => {
  const pending = Object.values(manifest.bin);
  const visited = new Set<string>();
  const scanner = new Transpiler({ loader: 'ts' });
  while (pending.length > 0) {
    const file = pending.pop();
    if (file !== undefined && !visited.has(file)) {
      visited.add(file);
      const absolute = join(packageRoot, file);
      const { imports } = scanner.scan(readFileSync(absolute, 'utf8'));
      for (const imported of imports.filter((entry) =>
        entry.path.startsWith('.'),
      )) {
        const target = resolve(dirname(absolute), imported.path);
        const resolved = [
          target,
          `${target}.ts`,
          join(target, 'index.ts'),
        ].find(existsSync);
        if (resolved === undefined) {
          throw new Error(`Unresolved import ${imported.path} in ${file}`);
        }
        pending.push(relative(packageRoot, resolved));
      }
    }
  }
  return [...visited].sort();
};

describe('published CLI import closure', () => {
  it('ships every reachable runtime module and no unreachable source files', () => {
    expect(
      manifest.files.filter((file) => file.startsWith('src/')).sort(),
    ).toEqual(importClosure());
  });
});
