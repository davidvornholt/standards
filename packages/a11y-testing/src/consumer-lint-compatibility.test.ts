import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findBiomeSuppressions,
  listManagedTextFiles,
  parseIgnoredDirectoryNames,
  type TextFile,
} from './consumer-lint-compatibility';

const packageRoot = join(import.meta.dir, '..');
const repositoryRoot = join(packageRoot, '../..');

const textFile = (path: string, source: string): TextFile => ({ path, source });

// This package syncs into consumer repos whose Biome configs may disable rules
// its sources would suppress; a disabled rule turns an inline suppression into
// an unused-suppression diagnostic that fails consumer --error-on-warnings
// lint gates. Every repo's own mandatory lint task already proves the sources
// lint clean, so this contract is pinned by a static scan instead of spawning
// Biome — subprocess invocations stall nondeterministically on contended
// hosted runners.
describe('canonical consumer lint compatibility', () => {
  it('ships no inline Biome suppressions in managed text files', () => {
    const files = listManagedTextFiles(repositoryRoot, packageRoot);
    expect(files.length).toBeGreaterThan(0);
    expect(findBiomeSuppressions(files)).toEqual([]);
  });
});

describe('Biome suppression recognition', () => {
  it.each([
    '.mts',
    '.cts',
    '.d.mts',
    '.d.cts',
  ])('detects suppressions in TypeScript module files ending in %s', (suffix) => {
    const files = [
      textFile(
        `src/canonical${suffix}`,
        '// biome-ignore lint/suspicious/noConsole: regression fixture',
      ),
    ];
    expect(findBiomeSuppressions(files)).toEqual([`src/canonical${suffix}:1`]);
  });

  it('covers every directive prefix and diagnostic category', () => {
    const files = [
      textFile(
        'src/directives.ts',
        [
          '// biome-ignore lint/suspicious/noConsole: fixture',
          '// biome-ignore-all assist/source/useSortedKeys: fixture',
          '/* biome-ignore-start syntax: fixture */',
          '/* biome-ignore-end format: fixture */',
        ].join('\n'),
      ),
    ];
    expect(findBiomeSuppressions(files)).toEqual([
      'src/directives.ts:1',
      'src/directives.ts:2',
      'src/directives.ts:3',
      'src/directives.ts:4',
    ]);
  });

  it('recognizes suppression comments across supported language families', () => {
    const files = [
      textFile(
        'src/canonical.jsonc',
        '// biome-ignore lint/suspicious/noCommentText: fixture',
      ),
      textFile(
        'src/canonical.css',
        '/* biome-ignore lint/suspicious/noDuplicateProperties: fixture */',
      ),
      textFile(
        'src/canonical.graphql',
        '# biome-ignore lint/nursery/useDeprecatedReason: fixture',
      ),
      textFile('src/canonical.html', '<!-- biome-ignore format: fixture -->'),
    ];
    expect(findBiomeSuppressions(files)).toEqual([
      'src/canonical.jsonc:1',
      'src/canonical.css:1',
      'src/canonical.graphql:1',
      'src/canonical.html:1',
    ]);
  });

  it('does not treat ordinary strings as suppression comments', () => {
    const files = [
      textFile(
        'src/documentation.ts',
        [
          'const name = "biome-ignore lint/suspicious/noConsole: docs";',
          'const example = "// biome-ignore format: docs";',
        ].join('\n'),
      ),
    ];
    expect(findBiomeSuppressions(files)).toEqual([]);
  });
});

describe('sync-managed file selection', () => {
  it('derives generated and installed directories from the ignore contract', () => {
    expect(
      parseIgnoredDirectoryNames(
        ['node_modules/', '.turbo/', 'dist/', '.next/', '*.log'].join('\n'),
      ),
    ).toEqual(new Set(['.git', 'node_modules', '.turbo', 'dist', '.next']));
  });

  it('does not scan files outside the sync-managed directory universe', () => {
    const fixtureRoot = mkdtempSync(
      join(tmpdir(), 'consumer-lint-compatibility-'),
    );
    const fixturePackage = join(fixtureRoot, 'packages/a11y-testing');
    try {
      mkdirSync(join(fixtureRoot, 'template'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'template/.gitignore'),
        ['node_modules/', '.turbo/', 'dist/', '.next/'].join('\n'),
      );
      mkdirSync(join(fixturePackage, 'src'), { recursive: true });
      writeFileSync(join(fixturePackage, 'src/managed.ts'), 'export {};\n');
      for (const directory of [
        '.git',
        '.turbo',
        'dist',
        '.next',
        'node_modules',
      ]) {
        mkdirSync(join(fixturePackage, directory), { recursive: true });
        writeFileSync(
          join(fixturePackage, directory, 'generated.js'),
          '// biome-ignore lint/suspicious/noConsole: ignored fixture',
        );
      }

      const files = listManagedTextFiles(fixtureRoot, fixturePackage);
      expect(files.map((file) => file.path)).toEqual(['src/managed.ts']);
      expect(findBiomeSuppressions(files)).toEqual([]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
