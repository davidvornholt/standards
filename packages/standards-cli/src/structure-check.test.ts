import { afterEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { collectStructureProblems } from './structure-check';
import {
  buildConsumer,
  CANONICAL_SCRIPTS,
  cleanupStructureTmps,
  newStructureTmp,
  consumerRootManifest as rootManifest,
  writeInto as write,
} from './structure-test-support';

afterEach(cleanupStructureTmps);
const collect = (dir: string) => collectStructureProblems(dir, 'consumer');
const WORKSPACES_REQUIREMENT =
  'package.json: "workspaces" must be a non-empty array of literal paths or one-level "<dir>/*" patterns';
const aliasProblem = (name: string): string =>
  `package.json: root script "${name}" must invoke Turbo directly with "turbo"`;
const aliasSyntaxProblem = (name: string): string =>
  `package.json: root script "${name}" contains shell syntax the structure gate does not parse (quotes, |, ;, #, backticks, $(, CR/LF line breaks, or malformed ampersand separators); write one command with plain arguments, using --filter=./apps/* for a glob`;

describe('collectStructureProblems basics and scripts', () => {
  it('accepts a canonical consumer', async () => {
    expect(await collect(buildConsumer())).toEqual([]);
  });

  it.each([undefined, 'bun@1.4', 'bun@^1.4.0', 'npm@11.0.0'])(
    'requires an exact Bun package manager pin: %s',
    async (packageManager) => {
      const consumer = buildConsumer(rootManifest({ packageManager }));
      expect(await collect(consumer)).toContain(
        'package.json: "packageManager" must pin an exact bun@x.y.z version',
      );
    },
  );

  it('fails when package.json is missing', async () => {
    const consumer = newStructureTmp('structure-');
    expect(await collect(consumer)).toEqual([
      'package.json must exist and contain a JSON object',
      'secrets/ci.yaml: must exist as a SOPS-encrypted file; the synced CI workflows read ci.ntfy_topic_url and, when automatic sync is enabled, ci.broker_app from it',
      'secrets/ci.example.yaml: must exist and mirror the key shape of secrets/ci.yaml with plaintext placeholders',
    ]);
  });

  it('rejects fail-open root gate scripts', async () => {
    const expected = [
      'package.json: root script "check" must run turbo run lint check-types test build test:a11y --output-logs=errors-only',
      'package.json: root script "check:fix" must run turbo run lint:fix check-types test build test:a11y --output-logs=errors-only',
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

  /* Per-shape coverage lives in structure-script.test.ts with the diagnostic
     itself; this keeps one parser-null input wired through root inspection. */
  it('requires safe filtered Turbo convenience aliases', async () => {
    const scripts = {
      ...(rootManifest().scripts as Record<string, string>),
      dev: 'turbo run dev --filter @repo/web',
      db: 'bun run scripts/db.ts',
      preview: "turbo run dev --filter './apps/*'",
    };
    const problems = await collect(buildConsumer(rootManifest({ scripts })));
    expect(problems).toEqual([
      aliasProblem('db'),
      aliasSyntaxProblem('preview'),
    ]);
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

  it('surfaces README and CI secrets problems through the root entry point', async () => {
    const consumer = buildConsumer();
    rmSync(join(consumer, 'apps/web/README.md'));
    rmSync(join(consumer, 'secrets/ci.yaml'));
    const problems = await collect(consumer);
    expect(problems).toEqual([
      'apps/web: repo-owned workspace must have a non-empty README.md',
      'secrets/ci.yaml: must exist as a SOPS-encrypted file; the synced CI workflows read ci.ntfy_topic_url and, when automatic sync is enabled, ci.broker_app from it',
    ]);
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
  ])(
    'rejects malformed workspace declarations %#',
    async (workspaces, expected) => {
      const consumer = buildConsumer(rootManifest({ workspaces }));
      expect(await collect(consumer)).toContain(expected);
    },
  );

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
