import { afterEach, describe, expect, it } from 'bun:test';
import { collectStructureProblems } from './structure-check';
import {
  CANONICAL_SCRIPTS,
  cleanupStructureTmps,
  newStructureTmp,
  ROOT_LINT_SCRIPTS,
  TSCONFIG,
  turboJson,
  writeInto as write,
  writeCiSecretsPair,
} from './structure-test-support';

afterEach(cleanupStructureTmps);

const CLI = 'bun packages/standards-cli/src/cli.ts';
const SOURCE_GATE_COMMANDS = {
  check: [
    `${CLI} structure --profile source`,
    `${CLI} source-text`,
    `${CLI} dependabot --check`,
    `${CLI} github --check`,
    'turbo run lint check-types test --output-logs=errors-only',
  ],
  'check:fix': [
    `${CLI} structure --profile source`,
    `${CLI} source-text`,
    `${CLI} dependabot --write`,
    `${CLI} github --check`,
    'turbo run lint:fix check-types test --output-logs=errors-only',
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
  packageManager: 'bun@1.4.0',
  workspaces: ['packages/*'],
  scripts: {
    standards: CLI,
    check: SOURCE_GATE_COMMANDS.check.join(' && '),
    'check:fix': SOURCE_GATE_COMMANDS['check:fix'].join(' && '),
    ...ROOT_LINT_SCRIPTS,
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
  const dir = newStructureTmp('structure-source-');
  write(dir, 'package.json', JSON.stringify(root));
  write(dir, 'turbo.json', turboJson());
  writeCiSecretsPair(dir);
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
      'package.json: root script "check" must run turbo run lint check-types test build test:a11y --output-logs=errors-only',
      'package.json: root script "check:fix" must run turbo run lint:fix check-types test build test:a11y --output-logs=errors-only',
      'packages/standards-cli: internal workspace version must be "0.0.0"',
      'packages/standards-cli: package must define its public API with "exports"',
    ]);
  });

  it('pins the deliberate source root gate scripts exactly', async () => {
    const scripts = {
      standards: `true && ${CLI}`,
      check:
        'standards check && turbo run lint check-types test build test:a11y --output-logs=errors-only',
      'check:fix':
        'standards check && turbo run lint:fix check-types test build test:a11y --output-logs=errors-only',
      lint: `true && ${ROOT_LINT_SCRIPTS.lint}`,
    };
    const problems = await collectStructureProblems(
      buildSource(sourceRootManifest({ scripts })),
      'source',
    );
    expect(problems).toEqual([
      `package.json: root script "standards" must run exactly ${CLI}`,
      `package.json: root script "check" must run exactly ${SOURCE_GATE_COMMANDS.check.join(' && ')}`,
      `package.json: root script "check:fix" must run exactly ${SOURCE_GATE_COMMANDS['check:fix'].join(' && ')}`,
      `package.json: root script "lint" must run exactly ${ROOT_LINT_SCRIPTS.lint}`,
      `package.json: root script "lint:fix" must run exactly ${ROOT_LINT_SCRIPTS['lint:fix']}`,
    ]);
  });

  it.each(INVALID_SOURCE_GATES)(
    'rejects a non-exact source gate: %s',
    async (_label, name, script) => {
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
    },
  );

  it('requires the published CLI workspace to exist', async () => {
    const problems = await collectStructureProblems(
      buildSource(sourceRootManifest(), null),
      'source',
    );
    expect(problems).toContain(
      'packages/standards-cli: the source profile requires the published CLI workspace',
    );
  });

  it('rejects workspace lint scripts in the source repository too', async () => {
    const problems = await collectStructureProblems(
      buildSource(
        sourceRootManifest(),
        cliManifest({
          scripts: { ...CANONICAL_SCRIPTS, ...ROOT_LINT_SCRIPTS },
        }),
      ),
      'source',
    );
    expect(problems).toEqual([
      'packages/standards-cli: remove script "lint"; linting runs once at the repository root through the root "lint" and "lint:fix" scripts',
      'packages/standards-cli: remove script "lint:fix"; linting runs once at the repository root through the root "lint" and "lint:fix" scripts',
    ]);
  });

  it('requires the root lint tasks in the source repository too', async () => {
    const dir = buildSource();
    write(
      dir,
      'turbo.json',
      turboJson({ lint: { outputs: [] }, '//#lint:fix': { outputs: [] } }),
    );
    expect(await collectStructureProblems(dir, 'source')).toEqual([
      'turbo.json: define the root task "//#lint" as { "outputs": [] }; Turbo runs the root "lint" script only through that task, so without it turbo run lint never runs Biome',
      'turbo.json: set "cache": false on the root task "//#lint:fix"; a cache hit replays the previous output instead of running Biome\'s fixes',
      'turbo.json: remove task "lint"; linting runs once at the repository root through the root tasks "//#lint" and "//#lint:fix"',
    ]);
  });

  it('holds the published CLI to every other workspace rule', async () => {
    const problems = await collectStructureProblems(
      buildSource(sourceRootManifest(), cliManifest({ scripts: {} })),
      'source',
    );
    expect(problems).toContain(
      'packages/standards-cli: script "test" must run bun test or bun test --isolate',
    );
  });
});
