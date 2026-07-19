import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const packageRoot = join(import.meta.dir, '..');

const lintableSuffixes = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.css',
];

// Built from parts so this file's own scan does not match the marker literal.
const suppressionMarker = ['biome', 'ignore'].join('-');

const listLintableFiles = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') {
      return [];
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return listLintableFiles(path);
    }
    return lintableSuffixes.some((suffix) => entry.name.endsWith(suffix))
      ? [path]
      : [];
  });

// This package syncs into consumer repos whose Biome configs may disable rules
// its sources would suppress; a disabled rule turns an inline suppression into
// an unused-suppression diagnostic that fails consumer --error-on-warnings
// lint gates. Every repo's own mandatory lint task already proves the sources
// lint clean, so this contract is pinned by a static scan instead of spawning
// Biome — subprocess invocations stall nondeterministically on contended
// hosted runners.
describe('canonical consumer lint compatibility', () => {
  it('ships no inline Biome suppressions in lintable files', () => {
    const files = listLintableFiles(packageRoot);
    expect(files.length).toBeGreaterThan(0);
    const suppressions = files.flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          line.includes(suppressionMarker)
            ? [`${relative(packageRoot, path)}:${index + 1}`]
            : [],
        ),
    );
    expect(suppressions).toEqual([]);
  });
});
