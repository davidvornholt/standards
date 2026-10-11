import { afterEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { collectStructureProblems } from './structure-check';
import {
  buildConsumer,
  CANONICAL_SCRIPTS,
  CANONICAL_TURBO_TASKS,
  cleanupStructureTmps,
  ROOT_LINT_SCRIPTS,
  ROOT_LINT_TASKS,
  consumerRootManifest as rootManifest,
  turboJson,
  writeInto as write,
} from './structure-test-support';

afterEach(cleanupStructureTmps);
const collect = (dir: string) => collectStructureProblems(dir, 'consumer');
const WORKSPACES_REQUIREMENT =
  'package.json: "workspaces" must be a non-empty array of literal paths or one-level "<dir>/*" patterns';
const aliasProblem = (name: string): string =>
  `package.json: root script "${name}" must invoke Turbo directly with "turbo"`;
const LINT_TASK_PROBLEMS = {
  defineLint:
    'turbo.json: define the root task "//#lint" as { "outputs": [] }; Turbo runs the root "lint" script only through that task, so without it turbo run lint never runs Biome',
  defineLintFix:
    'turbo.json: define the root task "//#lint:fix" as { "cache": false, "outputs": [] }; Turbo runs the root "lint:fix" script only through that task, so without it turbo run lint:fix never runs Biome',
  lintInputs:
    'turbo.json: remove "inputs" from the root task "//#lint"; the default inputs cover every file Biome checks, and a narrower set replays a cached pass after a linted file changes',
  lintFixCache:
    'turbo.json: set "cache": false on the root task "//#lint:fix"; a cache hit replays the previous output instead of running Biome\'s fixes',
} as const;
const removeLintTaskProblem = (key: string): string =>
  `turbo.json: remove task "${key}"; linting runs once at the repository root through the root tasks "//#lint" and "//#lint:fix"`;
const aliasSyntaxProblem = (name: string): string =>
  `package.json: root script "${name}" contains shell syntax the structure gate does not parse (quotes, |, ;, #, backticks, $(, CR/LF line breaks, or malformed ampersand separators); write one command with plain arguments, using --filter=./apps/* for a glob`;

describe('collectStructureProblems basics and scripts', () => {
  it('accepts a canonical consumer without workspace READMEs', async () => {
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

  it('requires the root lint scripts', async () => {
    const scripts = Object.fromEntries(
      Object.entries(rootManifest().scripts as Record<string, string>).filter(
        ([name]) => !(name in ROOT_LINT_SCRIPTS),
      ),
    );
    expect(await collect(buildConsumer(rootManifest({ scripts })))).toEqual([
      'package.json: root script "lint" must run exactly biome check --error-on-warnings .',
      'package.json: root script "lint:fix" must run exactly biome check --write --error-on-warnings .',
    ]);
  });

  it.each([
    ['lint', 'turbo run lint'],
    ['lint', 'biome check .'],
    ['lint', 'biome check --error-on-warnings apps'],
    ['lint', 'biome check --error-on-warnings . --help'],
    ['lint', 'biome check --error-on-warnings . || true'],
    ['lint', 'cd apps/web && biome check --error-on-warnings .'],
    ['lint', 'exit 0 && biome check --error-on-warnings .'],
    ['lint:fix', 'biome check --error-on-warnings .'],
    ['lint:fix', 'biome check --write .'],
    ['lint:fix', 'cd apps/web && biome check --write --error-on-warnings .'],
    ['lint:fix', 'exit 0 && biome check --write --error-on-warnings .'],
  ])('rejects a wrong root %s script: %s', async (name, script) => {
    const scripts = {
      ...(rootManifest().scripts as Record<string, string>),
      [name]: script,
    };
    const expected =
      name === 'lint'
        ? 'biome check --error-on-warnings .'
        : 'biome check --write --error-on-warnings .';
    expect(await collect(buildConsumer(rootManifest({ scripts })))).toEqual([
      `package.json: root script "${name}" must run exactly ${expected}`,
    ]);
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

  it('surfaces CI secrets problems through the root entry point', async () => {
    const consumer = buildConsumer();
    rmSync(join(consumer, 'secrets/ci.yaml'));
    const problems = await collect(consumer);
    expect(problems).toEqual([
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

  it('surfaces a workspace lint script through the root entry point', async () => {
    const consumer = buildConsumer();
    write(
      consumer,
      'packages/ui/package.json',
      JSON.stringify({
        name: '@repo/ui',
        version: '0.0.0',
        exports: { './button': './src/button.tsx' },
        scripts: { ...CANONICAL_SCRIPTS, ...ROOT_LINT_SCRIPTS },
      }),
    );
    expect(await collect(consumer)).toEqual([
      'packages/ui: remove script "lint"; linting runs once at the repository root through the root "lint" and "lint:fix" scripts',
      'packages/ui: remove script "lint:fix"; linting runs once at the repository root through the root "lint" and "lint:fix" scripts',
    ]);
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

describe('collectStructureProblems root lint tasks', () => {
  it.each([
    [
      'workspace lint tasks in place of the root tasks',
      {
        lint: { outputs: [] },
        'lint:fix': { cache: false, outputs: [] },
        test: { outputs: [] },
      },
      [
        LINT_TASK_PROBLEMS.defineLint,
        LINT_TASK_PROBLEMS.defineLintFix,
        removeLintTaskProblem('lint'),
        removeLintTaskProblem('lint:fix'),
      ],
    ],
    [
      'a leftover workspace lint task beside the root tasks',
      { ...CANONICAL_TURBO_TASKS, lint: { dependsOn: ['^lint'] } },
      [removeLintTaskProblem('lint')],
    ],
    [
      'package lint overrides',
      {
        ...CANONICAL_TURBO_TASKS,
        'web#lint': { outputs: [] },
        '@repo/ui#lint:fix': { cache: false },
      },
      [
        removeLintTaskProblem('web#lint'),
        removeLintTaskProblem('@repo/ui#lint:fix'),
      ],
    ],
    [
      'root tasks that are not task objects',
      { '//#lint': null, '//#lint:fix': true },
      [LINT_TASK_PROBLEMS.defineLint, LINT_TASK_PROBLEMS.defineLintFix],
    ],
    [
      'narrowed //#lint inputs',
      {
        ...CANONICAL_TURBO_TASKS,
        '//#lint': { inputs: ['apps/**'], outputs: [] },
      },
      [LINT_TASK_PROBLEMS.lintInputs],
    ],
    [
      'explicit default //#lint inputs',
      {
        ...CANONICAL_TURBO_TASKS,
        '//#lint': { inputs: ['$TURBO_DEFAULT$'], outputs: [] },
      },
      [LINT_TASK_PROBLEMS.lintInputs],
    ],
    [
      'a cached //#lint:fix',
      { ...CANONICAL_TURBO_TASKS, '//#lint:fix': { outputs: [] } },
      [LINT_TASK_PROBLEMS.lintFixCache],
    ],
    [
      'an explicitly cached //#lint:fix',
      {
        ...CANONICAL_TURBO_TASKS,
        '//#lint:fix': { cache: true, outputs: [] },
      },
      [LINT_TASK_PROBLEMS.lintFixCache],
    ],
  ])('rejects %s', async (_label, tasks, expected) => {
    const consumer = buildConsumer();
    write(consumer, 'turbo.json', turboJson(tasks));
    expect(await collect(consumer)).toEqual(expected);
  });
});

describe('collectStructureProblems turbo.json input', () => {
  it.each([
    ['without tasks', '{ "$schema": "https://turbo.build/schema.json" }'],
    ['with tasks that are not an object', '{ "tasks": [] }'],
  ])(
    'requires both root lint tasks in a turbo.json %s',
    async (_label, raw) => {
      const consumer = buildConsumer();
      write(consumer, 'turbo.json', raw);
      expect(await collect(consumer)).toEqual([
        LINT_TASK_PROBLEMS.defineLint,
        LINT_TASK_PROBLEMS.defineLintFix,
      ]);
    },
  );

  it.each([
    ['missing', null],
    ['malformed', '{ "tasks": '],
    ['an array', '[]'],
  ])('rejects a turbo.json that is %s', async (_label, raw) => {
    const consumer = buildConsumer();
    if (raw === null) {
      rmSync(join(consumer, 'turbo.json'));
    } else {
      write(consumer, 'turbo.json', raw);
    }
    expect(await collect(consumer)).toEqual([
      'turbo.json must exist and contain a JSON object',
    ]);
  });

  it('accepts comments, trailing commas, and extra root task settings', async () => {
    const consumer = buildConsumer();
    write(
      consumer,
      'turbo.json',
      [
        '{',
        '  "tasks": {',
        '    // Biome lints the whole repository once from the root.',
        '    "//#lint": { "cache": false, "outputs": [], "passThroughEnv": ["CI"] },',
        '    "//#lint:fix": { "cache": false, "outputs": [], },',
        '    /* Unrelated lint-like task names stay allowed. */',
        '    "lint:md": { "outputs": [] },',
        '  },',
        '}',
        '',
      ].join('\n'),
    );
    expect(await collect(consumer)).toEqual([]);
  });

  it('reports turbo.json problems beside a missing root manifest', async () => {
    const consumer = buildConsumer();
    rmSync(join(consumer, 'package.json'));
    write(consumer, 'turbo.json', turboJson({ ...ROOT_LINT_TASKS, lint: {} }));
    expect(await collect(consumer)).toEqual([
      'package.json must exist and contain a JSON object',
      removeLintTaskProblem('lint'),
    ]);
  });
});
