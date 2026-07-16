import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectWorkspace, type Workspace } from './structure-workspace';

const tmps: Array<string> = [];

afterEach(() => {
  for (const dir of tmps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const CANONICAL_SCRIPTS = {
  'check-types': 'tsc --noEmit',
  lint: 'biome check --error-on-warnings .',
  'lint:fix': 'biome check --write --error-on-warnings .',
  test: 'bun test',
};

const TSCONFIG = '{ "extends": "@davidvornholt/typescript-config/base" }\n';

const makeWorkspace = (
  manifest: Record<string, unknown>,
  files: Record<string, string> = { 'tsconfig.json': TSCONFIG },
  rel = 'apps/web',
): Workspace => {
  const dir = mkdtempSync(join(tmpdir(), 'structure-ws-'));
  tmps.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return { rel, dir, manifest };
};

const inspect = (ws: Workspace, names: ReadonlySet<string> = new Set()) =>
  inspectWorkspace(ws, names, 'consumer');

const baseManifest = (): Record<string, unknown> => ({
  name: '@repo/web',
  version: '0.0.0',
  scripts: { ...CANONICAL_SCRIPTS },
});

describe('inspectWorkspace manifest rules', () => {
  it('accepts a canonical workspace without an a11y suite', async () => {
    const result = await inspect(makeWorkspace(baseManifest()));
    expect(result).toEqual({ problems: [], hasA11ySuite: false });
  });

  it('reports every missing or divergent canonical script', async () => {
    const ws = makeWorkspace({
      ...baseManifest(),
      scripts: {
        'check-types': 'tsc --noEmit --help',
        lint: 'biome check --error-on-warnings . --help',
        'lint:fix': 'biome check --write --error-on-warnings . --version',
        test: 'bun test --help',
      },
    });
    const { problems } = await inspect(ws);
    expect(problems).toContain(
      'apps/web: script "check-types" must run tsc --noEmit',
    );
    expect(problems).toContain(
      'apps/web: script "lint" must run biome check --error-on-warnings .',
    );
    expect(problems).toContain(
      'apps/web: script "lint:fix" must run biome check --write --error-on-warnings .',
    );
    expect(problems).toContain('apps/web: script "test" must run bun test');
  });

  it('requires internal workspace version 0.0.0', async () => {
    const ws = makeWorkspace({ ...baseManifest(), version: '1.2.3' });
    const { problems } = await inspect(ws);
    expect(problems).toContain(
      'apps/web: internal workspace version must be "0.0.0"',
    );
  });

  it('requires workspace:* for internal dependencies in every field', async () => {
    const ws = makeWorkspace({
      ...baseManifest(),
      dependencies: { '@repo/ui': '0.0.0', 'left-pad': '^1.0.0' },
      devDependencies: { '@repo/config': 'workspace:*' },
    });
    const { problems } = await inspect(
      ws,
      new Set(['@repo/ui', '@repo/config']),
    );
    expect(problems).toEqual([
      'apps/web: internal dependency "@repo/ui" must use "workspace:*"',
    ]);
  });

  it('requires exports for packages/* but not for apps/*', async () => {
    const pkg = makeWorkspace(
      { ...baseManifest(), name: '@repo/ui' },
      { 'tsconfig.json': TSCONFIG },
      'packages/ui',
    );
    const app = makeWorkspace(baseManifest());
    expect((await inspect(pkg)).problems).toEqual([
      'packages/ui: package must define its public API with "exports"',
    ]);
    expect((await inspect(app)).problems).toEqual([]);
  });

  it('exempts the shared config package from the inheritance rule', async () => {
    const ws = makeWorkspace(
      {
        ...baseManifest(),
        name: '@davidvornholt/typescript-config',
        exports: { './base': './base.json' },
      },
      { 'tsconfig.json': '{ "extends": "./base.json" }\n' },
      'packages/typescript-config',
    );
    expect((await inspect(ws)).problems).toEqual([]);
  });
});

describe('inspectWorkspace tsconfig and a11y wiring', () => {
  it('requires tsconfig.json to extend the shared config', async () => {
    const missing = makeWorkspace(baseManifest(), {});
    const standalone = makeWorkspace(baseManifest(), {
      'tsconfig.json': '{ "compilerOptions": { "strict": true } }\n',
    });
    const expected =
      'apps/web: tsconfig.json must extend @davidvornholt/typescript-config';
    expect((await inspect(missing)).problems).toEqual([expected]);
    expect((await inspect(standalone)).problems).toEqual([expected]);
  });

  it.each([
    '',
    'playwright test --list',
  ])('rejects a non-executing a11y gate %#', async (testA11y) => {
    const ws = makeWorkspace(
      {
        ...baseManifest(),
        scripts: { ...CANONICAL_SCRIPTS, 'test:a11y': testA11y },
      },
      {
        'tsconfig.json': TSCONFIG,
        'a11y/home.a11y.ts': 'export {};\n',
      },
    );
    const result = await inspect(ws);
    expect(result.hasA11ySuite).toBe(true);
    expect(result.problems).toEqual([
      'apps/web: a *.a11y.ts suite requires a non-empty "test:a11y" script that runs playwright test',
      'apps/web: a *.a11y.ts suite requires a direct dependency on @axe-core/playwright',
      'apps/web: a *.a11y.ts suite requires a direct dependency on @playwright/test',
    ]);
  });

  it('accepts a fully wired explicit a11y suite', async () => {
    const ws = makeWorkspace(
      {
        ...baseManifest(),
        scripts: {
          ...CANONICAL_SCRIPTS,
          'test:a11y':
            'bun run prepare-a11y && playwright test --config playwright.config.ts',
        },
        devDependencies: {
          '@axe-core/playwright': '^4.0.0',
          '@playwright/test': '^1.0.0',
        },
      },
      {
        'tsconfig.json': TSCONFIG,
        'playwright.config.ts': 'export {};\n',
        'a11y/home.a11y.ts': 'export {};\n',
      },
    );
    const result = await inspect(ws);
    expect(result).toEqual({ problems: [], hasA11ySuite: true });
  });

  it('only activates a11y wiring for explicit suites in source', async () => {
    const ws = makeWorkspace(baseManifest(), {
      'tsconfig.json': TSCONFIG,
      'playwright.config.ts': 'export {};\n',
      'node_modules/pkg/home.a11y.ts': 'export {};\n',
    });
    expect(await inspect(ws)).toEqual({
      problems: [],
      hasA11ySuite: false,
    });
  });
});
