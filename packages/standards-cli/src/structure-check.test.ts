import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectStructureProblems } from './structure-check';

const tmps: Array<string> = [];

afterEach(() => {
  while (tmps.length > 0) {
    const dir = tmps.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

const write = (root: string, rel: string, content: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
};

const CANONICAL_SCRIPTS = {
  'check-types': 'tsc --noEmit',
  lint: 'biome check --error-on-warnings .',
  'lint:fix': 'biome check --write --error-on-warnings .',
  test: 'bun test',
};

const TSCONFIG = '{ "extends": "@davidvornholt/typescript-config/base" }\n';

const rootManifest = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  name: 'app',
  version: '0.0.0',
  workspaces: ['apps/*', 'packages/*'],
  scripts: {
    standards: 'standards',
    check: 'standards check && turbo run lint check-types test build test:a11y',
    'check:fix':
      'standards check && turbo run lint:fix check-types test build test:a11y',
  },
  ...overrides,
});

// A consumer with one app and one package, both canonical, no a11y suite.
const buildConsumer = (
  root: Record<string, unknown> = rootManifest(),
): string => {
  const consumer = mkdtempSync(join(tmpdir(), 'structure-'));
  tmps.push(consumer);
  write(consumer, 'package.json', JSON.stringify(root));
  write(
    consumer,
    'apps/web/package.json',
    JSON.stringify({
      name: '@repo/web',
      version: '0.0.0',
      scripts: CANONICAL_SCRIPTS,
      dependencies: { '@repo/ui': 'workspace:*' },
    }),
  );
  write(consumer, 'apps/web/tsconfig.json', TSCONFIG);
  write(
    consumer,
    'packages/ui/package.json',
    JSON.stringify({
      name: '@repo/ui',
      version: '0.0.0',
      exports: { './button': './src/button.tsx' },
      scripts: CANONICAL_SCRIPTS,
    }),
  );
  write(consumer, 'packages/ui/tsconfig.json', TSCONFIG);
  return consumer;
};

describe('collectStructureProblems', () => {
  it('accepts a canonical consumer', async () => {
    expect(await collectStructureProblems(buildConsumer())).toEqual([]);
  });

  it('fails when package.json is missing', async () => {
    const consumer = mkdtempSync(join(tmpdir(), 'structure-'));
    tmps.push(consumer);
    expect(await collectStructureProblems(consumer)).toEqual([
      'package.json must exist and contain a JSON object',
    ]);
  });

  it('requires the canonical root gate scripts', async () => {
    const consumer = buildConsumer(
      rootManifest({
        scripts: { check: 'standards check', 'check:fix': 'standards check' },
      }),
    );
    const problems = await collectStructureProblems(consumer);
    expect(problems).toContain(
      'package.json: root script "check" must run turbo run lint check-types test build test:a11y',
    );
    expect(problems).toContain(
      'package.json: root script "check:fix" must run turbo run lint:fix check-types test build test:a11y',
    );
  });

  it('requires convenience root scripts to be filtered Turbo aliases', async () => {
    const scripts = {
      ...(rootManifest().scripts as Record<string, string>),
      dev: 'turbo run dev --filter @repo/web',
      db: 'bun run scripts/db.ts',
    };
    const problems = await collectStructureProblems(
      buildConsumer(rootManifest({ scripts })),
    );
    expect(problems).toEqual([
      'package.json: root script "db" must delegate through Turbo with an explicit --filter',
    ]);
  });

  it('requires a root test:a11y script once any workspace has a suite', async () => {
    const consumer = buildConsumer();
    write(consumer, 'apps/web/a11y/home.a11y.ts', 'export {};\n');
    const problems = await collectStructureProblems(consumer);
    expect(problems).toContain(
      'package.json: root script "test:a11y" must run turbo run test:a11y',
    );
  });

  it('rejects unsupported workspace glob patterns', async () => {
    const problems = await collectStructureProblems(
      buildConsumer(rootManifest({ workspaces: ['apps/**'] })),
    );
    expect(problems).toContain(
      'package.json: unsupported workspaces pattern "apps/**"; use "<dir>/*" or a literal path',
    );
  });

  it('reports a workspace whose package.json is malformed', async () => {
    const consumer = buildConsumer();
    write(consumer, 'packages/broken/package.json', '{ not json');
    const problems = await collectStructureProblems(consumer);
    expect(problems).toContain(
      'packages/broken: package.json must contain a JSON object',
    );
  });

  it('surfaces per-workspace problems through the root entry point', async () => {
    const consumer = buildConsumer();
    write(
      consumer,
      'packages/ui/package.json',
      JSON.stringify({
        name: '@repo/ui',
        version: '1.0.0',
        exports: {},
        scripts: CANONICAL_SCRIPTS,
      }),
    );
    const problems = await collectStructureProblems(consumer);
    expect(problems).toEqual([
      'packages/ui: internal workspace version must be "0.0.0"',
    ]);
  });
});
