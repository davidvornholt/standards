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

const CLI = 'bun packages/standards-cli/src/cli.ts';
const CANONICAL_SCRIPTS = {
  'check-types': 'tsc --noEmit',
  lint: 'biome check --error-on-warnings .',
  'lint:fix': 'biome check --write --error-on-warnings .',
  test: 'bun test',
};
const TSCONFIG = '{ "extends": "@davidvornholt/typescript-config/base" }\n';
const SOURCE_GATE_COMMANDS = {
  check: [
    `${CLI} structure --profile source`,
    `${CLI} dependabot --check`,
    `${CLI} github --check`,
    'turbo run lint check-types test',
  ],
  'check:fix': [
    `${CLI} structure --profile source`,
    `${CLI} dependabot --write`,
    `${CLI} github --check`,
    'turbo run lint:fix check-types test',
  ],
} as const;
const INVALID_SOURCE_GATES = (['check', 'check:fix'] as const).flatMap(
  (name) => {
    const [structure, dependabot, github, turbo] = SOURCE_GATE_COMMANDS[name];
    return [
      [
        `${name} reversed`,
        name,
        [github, structure, dependabot, turbo].join(' && '),
      ],
      [
        `${name} interleaved`,
        name,
        [structure, 'true', dependabot, github, turbo].join(' && '),
      ],
      [
        `${name} extra`,
        name,
        ['true', structure, dependabot, github, turbo].join(' && '),
      ],
    ] as const;
  },
);

const sourceRootManifest = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  name: 'standards',
  version: '0.0.0',
  workspaces: ['packages/*'],
  scripts: {
    standards: CLI,
    check: SOURCE_GATE_COMMANDS.check.join(' && '),
    'check:fix': SOURCE_GATE_COMMANDS['check:fix'].join(' && '),
  },
  ...overrides,
});

const cliManifest = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  name: '@davidvornholt/standards',
  version: '0.6.0',
  bin: { standards: 'src/cli.ts' },
  scripts: CANONICAL_SCRIPTS,
  ...overrides,
});

// The standards source repository shape: the root gate runs the local CLI and
// the published bin-only CLI workspace carries a release SemVer.
const buildSource = (
  root: Record<string, unknown> = sourceRootManifest(),
  cli: Record<string, unknown> | null = cliManifest(),
): string => {
  const dir = mkdtempSync(join(tmpdir(), 'structure-source-'));
  tmps.push(dir);
  write(dir, 'package.json', JSON.stringify(root));
  if (cli !== null) {
    write(dir, 'packages/standards-cli/package.json', JSON.stringify(cli));
    write(dir, 'packages/standards-cli/tsconfig.json', TSCONFIG);
  }
  return dir;
};

describe('source profile', () => {
  it('accepts the standards source repository shape', async () => {
    expect(await collectStructureProblems(buildSource(), 'source')).toEqual([]);
  });

  it('keeps rejecting the source shape under the consumer profile', async () => {
    expect(await collectStructureProblems(buildSource(), 'consumer')).toEqual([
      'package.json: root script "check" must run turbo run lint check-types test build test:a11y',
      'package.json: root script "check:fix" must run turbo run lint:fix check-types test build test:a11y',
      'packages/standards-cli: internal workspace version must be "0.0.0"',
      'packages/standards-cli: package must define its public API with "exports"',
    ]);
  });

  it('pins the deliberate source root gate scripts exactly', async () => {
    const scripts = {
      standards: `true && ${CLI}`,
      check:
        'standards check && turbo run lint check-types test build test:a11y',
      'check:fix':
        'standards check && turbo run lint:fix check-types test build test:a11y',
    };
    const problems = await collectStructureProblems(
      buildSource(sourceRootManifest({ scripts })),
      'source',
    );
    expect(problems).toEqual([
      `package.json: root script "standards" must run exactly ${CLI}`,
      `package.json: root script "check" must run exactly ${SOURCE_GATE_COMMANDS.check.join(' && ')}`,
      `package.json: root script "check:fix" must run exactly ${SOURCE_GATE_COMMANDS['check:fix'].join(' && ')}`,
    ]);
  });

  it.each(
    INVALID_SOURCE_GATES,
  )('rejects a non-exact source gate: %s', async (_label, name, script) => {
    const root = sourceRootManifest();
    const scripts = {
      ...(root.scripts as Record<string, string>),
      [name]: script,
    };
    const problems = await collectStructureProblems(
      buildSource({ ...root, scripts }),
      'source',
    );
    expect(problems).toContain(
      `package.json: root script "${name}" must run exactly ${SOURCE_GATE_COMMANDS[name].join(' && ')}`,
    );
  });

  it('requires the published CLI workspace to exist', async () => {
    const problems = await collectStructureProblems(
      buildSource(sourceRootManifest(), null),
      'source',
    );
    expect(problems).toContain(
      'packages/standards-cli: the source profile requires the published CLI workspace',
    );
  });

  it('holds the published CLI to every other workspace rule', async () => {
    const problems = await collectStructureProblems(
      buildSource(sourceRootManifest(), cliManifest({ scripts: {} })),
      'source',
    );
    expect(problems).toContain(
      'packages/standards-cli: script "test" must run bun test',
    );
  });
});
