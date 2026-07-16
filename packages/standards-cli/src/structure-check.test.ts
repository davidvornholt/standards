import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectStructureProblems } from './structure-check';

const tmps: Array<string> = [];
afterEach(() => {
  for (const dir of tmps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
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
const collect = (dir: string) => collectStructureProblems(dir, 'consumer');
const WORKSPACES_REQUIREMENT =
  'package.json: "workspaces" must be a non-empty array of literal paths or one-level "<dir>/*" patterns';
const aliasProblem = (name: string): string =>
  `package.json: root script "${name}" must delegate through Turbo with an explicit --filter`;

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

describe('collectStructureProblems basics and scripts', () => {
  it('accepts a canonical consumer', async () => {
    expect(await collect(buildConsumer())).toEqual([]);
  });

  it('fails when package.json is missing', async () => {
    const consumer = mkdtempSync(join(tmpdir(), 'structure-'));
    tmps.push(consumer);
    expect(await collect(consumer)).toEqual([
      'package.json must exist and contain a JSON object',
    ]);
  });

  it('rejects fail-open root gate scripts', async () => {
    const expected = [
      'package.json: root script "check" must run turbo run lint check-types test build test:a11y',
      'package.json: root script "check:fix" must run turbo run lint:fix check-types test build test:a11y',
    ];
    const scripts = rootManifest().scripts as Record<string, string>;
    scripts.check =
      'echo "turbo run lint check-types test build test:a11y" || true';
    scripts['check:fix'] =
      'turbo run lint:fix check-types test build test:a11y # disabled';
    expect(await collect(buildConsumer(rootManifest({ scripts })))).toEqual(
      expected,
    );
  });

  it('requires safe filtered Turbo convenience aliases', async () => {
    const scripts = {
      ...(rootManifest().scripts as Record<string, string>),
      dev: 'turbo run dev --filter @repo/web',
      start: 'turbo run dev --filter=@repo/web',
      db: 'bun run scripts/db.ts',
      quoted: 'echo "turbo run dev --filter @repo/web"',
      help: 'turbo run --help --filter @repo/web',
      unfiltered: 'turbo run dev --filter',
    };
    const problems = await collect(buildConsumer(rootManifest({ scripts })));
    expect(problems).toEqual(
      ['db', 'quoted', 'help', 'unfiltered'].map(aliasProblem),
    );
  });

  it('requires a safe root test:a11y script once a workspace has a suite', async () => {
    const scripts = {
      ...(rootManifest().scripts as Record<string, string>),
      'test:a11y': '',
    };
    const consumer = buildConsumer(rootManifest({ scripts }));
    write(consumer, 'apps/web/a11y/home.a11y.ts', 'export {};\n');
    const problems = await collect(consumer);
    expect(problems).toContain(
      'package.json: root script "test:a11y" must run turbo run test:a11y',
    );
  });
});

describe('collectStructureProblems workspace declarations', () => {
  it.each([
    [undefined, WORKSPACES_REQUIREMENT],
    [{ packages: ['apps/*'] }, WORKSPACES_REQUIREMENT],
    [[], WORKSPACES_REQUIREMENT],
    [['apps/*', null], 'package.json: workspaces[1] must be a string'],
    [
      ['../outside'],
      'package.json: unsafe workspaces pattern "../outside"; use a relative path without "." or ".." segments',
    ],
  ])('rejects malformed workspace declarations %#', async (workspaces, expected) => {
    const consumer = buildConsumer(rootManifest({ workspaces }));
    expect(await collect(consumer)).toContain(expected);
  });

  it('treats a missing glob root as an empty match', async () => {
    const consumer = buildConsumer(rootManifest({ workspaces: ['empty/*'] }));
    expect(await collect(consumer)).toEqual([]);
  });

  it('rejects a glob root that is not a directory', async () => {
    const consumer = buildConsumer(rootManifest({ workspaces: ['blocked/*'] }));
    write(consumer, 'blocked', 'not a directory');
    expect(await collect(consumer)).toContain(
      'package.json: cannot read workspace directory "blocked" declared by "blocked/*"',
    );
  });

  it('rejects unsupported workspace glob patterns', async () => {
    const problems = await collect(
      buildConsumer(rootManifest({ workspaces: ['apps/**'] })),
    );
    expect(problems).toContain(
      'package.json: unsupported workspaces pattern "apps/**"; use "<dir>/*" or a literal path',
    );
  });

  it('reports a workspace whose package.json is malformed', async () => {
    const consumer = buildConsumer();
    write(consumer, 'packages/broken/package.json', '{ not json');
    const problems = await collect(consumer);
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
    const problems = await collect(consumer);
    expect(problems).toEqual([
      'packages/ui: internal workspace version must be "0.0.0"',
    ]);
  });
});
