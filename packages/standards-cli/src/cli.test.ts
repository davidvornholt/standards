// Black-box integration tests: drive the sync CLI as a subprocess against
// throwaway temp fixtures and assert its documented status/stdout/stderr.

import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import process from 'node:process';
import { parse as parseYaml } from 'yaml';

const ENGINE = join(import.meta.dir, 'cli.ts');
const ACTUAL_UPSTREAM = join(import.meta.dir, '../../..');
const SYNC_WORKFLOW = join(
  ACTUAL_UPSTREAM,
  '.github/workflows/standards-sync.yml',
);
const STANDARDS_WORKFLOW = join(
  ACTUAL_UPSTREAM,
  '.github/workflows/standards.yml',
);
const NOTIFY_WORKFLOW = join(
  ACTUAL_UPSTREAM,
  '.github/workflows/notify-pause.yml',
);
const SOPS_ACTION = join(
  ACTUAL_UPSTREAM,
  '.github/actions/sops-secret/action.yml',
);
const NON_WHITESPACE = /\S/u;
const SOPS_VERSION_ASSIGNMENT = /version=v\d+\.\d+\.\d+/gu;
const SOPS_CHECKSUM_ASSIGNMENT = /sha=[a-f0-9]{64}/gu;
const ACTIONLINT_ASSET_PATTERN =
  /actionlint_\$\{version\}_linux_\$\{arch\}\.tar\.gz/u;
const EXECUTABLE_MODE = 0o755;
const STD_PATHS: ReadonlyArray<string> = [
  'sync-standards.json',
  '.github/dependabot.base.yml',
  'managed',
];

type RunResult = { stdout: string; stderr: string; status: number };
type Lock = { upstream: string; sha: string; files: Record<string, string> };

const INVALID_POLICY_CASES = [
  [
    'malformed JSON',
    'not json',
    'sync-standards.local.json must contain valid JSON',
  ],
  [
    'a non-object root',
    'null',
    'sync-standards.local.json must be a JSON object',
  ],
  [
    'a wrong autoSync type',
    '{ "autoSync": "false" }',
    '"autoSync" must be a boolean',
  ],
  [
    'a wrong ref type',
    '{ "ref": 1 }',
    '"ref" must be a non-empty single-line string',
  ],
  [
    'a newline in ref',
    '{ "ref": "main\\npresent=false" }',
    '"ref" must be a non-empty single-line string',
  ],
  [
    'a carriage return in ref',
    '{ "ref": "main\\rpresent=false" }',
    '"ref" must be a non-empty single-line string',
  ],
  [
    'an unsupported field',
    '{ "branch": "stable" }',
    'contains unsupported field(s): branch',
  ],
] as const;

const DEPENDABOT_OVERLAY = [
  'updates:',
  '  - package-ecosystem: nix',
  '    directory: /',
  '    schedule:',
  '      interval: weekly',
  '  - package-ecosystem: bun',
  '    directory: /',
  '    ignore:',
  '      - dependency-name: left-pad',
  '        versions: [">1.0.0"]',
  '',
].join('\n');

const tmps: Array<string> = [];

const mkTmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(dir);
  return dir;
};
const write = (root: string, rel: string, content: string): void => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
};
const read = (root: string, rel: string): string =>
  readFileSync(join(root, rel), 'utf8');
const readLock = (root: string): Lock =>
  JSON.parse(read(root, 'sync-standards.lock')) as Lock;
const snapshotTree = (
  root: string,
  current = root,
  snapshot: Record<string, string> = {},
): Record<string, string> => {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      snapshotTree(root, path, snapshot);
    } else {
      snapshot[relative(root, path)] = readFileSync(path).toString('base64');
    }
  }
  return snapshot;
};
const readProductionGithubFiles = (): ReadonlyArray<{
  readonly content: string;
  readonly path: string;
}> =>
  ['.github/workflows', '.github/actions'].flatMap((root) =>
    Object.entries(snapshotTree(join(ACTUAL_UPSTREAM, root))).map(
      ([path, content]) => ({
        content: Buffer.from(content, 'base64').toString('utf8'),
        path: `${root}/${path}`,
      }),
    ),
  );

const runExecutable = (
  executable: string,
  cwd: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {},
): RunResult => {
  try {
    const stdout = execFileSync(executable, args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      status: e.status ?? 1,
    };
  }
};
const run = (cwd: string, args: ReadonlyArray<string>): RunResult =>
  runExecutable('bun', cwd, [ENGINE, ...args]);

const yamlStep = (path: string, stepName: string): string => {
  const lines = readFileSync(path, 'utf8').split('\n');
  const stepIndex = lines.findIndex(
    (line) => line.trim() === `- name: ${stepName}`,
  );
  if (stepIndex === -1) {
    throw new Error(`YAML step not found: ${stepName}`);
  }
  const stepIndent = (lines[stepIndex] ?? '').search(NON_WHITESPACE);
  const stepLines = [lines[stepIndex] ?? ''];
  for (let index = stepIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.length > 0 && line.search(NON_WHITESPACE) <= stepIndent) {
      break;
    }
    stepLines.push(line);
  }
  return stepLines.join('\n').trimEnd();
};
const yamlRunScript = (path: string, stepName: string): string => {
  const lines = yamlStep(path, stepName).split('\n');
  const runIndex = lines.findIndex((line) => line.trim() === 'run: |');
  if (runIndex === -1) {
    throw new Error(`YAML run script not found: ${stepName}`);
  }
  const runIndent = (lines[runIndex] ?? '').search(NON_WHITESPACE);
  const scriptPrefix = ' '.repeat(runIndent + 2);
  const scriptLines: Array<string> = [];
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.length > 0 && !line.startsWith(scriptPrefix)) {
      break;
    }
    scriptLines.push(
      line.startsWith(scriptPrefix) ? line.slice(scriptPrefix.length) : line,
    );
  }
  return scriptLines.join('\n').trimEnd();
};
const workflowRunScript = (stepName: string): string =>
  yamlRunScript(SYNC_WORKFLOW, stepName);

const runWorkflowVersionGuard = (version: string): RunResult => {
  const fixture = mkTmp('sync-version-');
  write(
    fixture,
    'node_modules/@davidvornholt/standards/package.json',
    JSON.stringify({ version }),
  );
  return runExecutable(
    'bash',
    fixture,
    [
      '-euo',
      'pipefail',
      '-c',
      workflowRunScript('Require compatible standards CLI'),
    ],
    { MINIMUM_STANDARDS_VERSION: '0.10.2' },
  );
};

type SopsActionOptions = {
  readonly ageKey?: string;
  readonly createSecretFile?: boolean;
  readonly failureMode?: 'fail' | 'fallback';
  readonly fallbackValue?: string;
  readonly sopsOutput?: string;
  readonly sopsStatus?: number;
};

const runSopsAction = (
  options: SopsActionOptions = {},
): {
  readonly curlCalled: boolean;
  readonly environment: string;
  readonly output: string;
  readonly result: RunResult;
} => {
  const fixture = mkTmp('sops-action-');
  const bin = join(fixture, 'bin');
  const runnerTemp = join(fixture, 'runner');
  mkdirSync(bin);
  mkdirSync(runnerTemp);
  const fakeSops = join(fixture, 'fake-sops');
  const curlMarker = join(fixture, 'curl-called');
  const environmentPath = join(fixture, 'github-env');
  const outputPath = join(fixture, 'github-output');
  write(
    fixture,
    'bin/curl',
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'printf called > "$CURL_MARKER"',
      'cp "$FAKE_SOPS" "$2"',
      '',
    ].join('\n'),
  );
  write(
    fixture,
    'bin/sha256sum',
    ['#!/usr/bin/env bash', 'exit 0', ''].join('\n'),
  );
  write(
    fixture,
    'fake-sops',
    [
      '#!/usr/bin/env bash',
      'if [ "$FAKE_SOPS_STATUS" -ne 0 ]; then',
      '  exit "$FAKE_SOPS_STATUS"',
      'fi',
      'printf \'%s\' "$FAKE_SOPS_OUTPUT"',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'curl'), EXECUTABLE_MODE);
  chmodSync(join(bin, 'sha256sum'), EXECUTABLE_MODE);
  chmodSync(fakeSops, EXECUTABLE_MODE);
  if (options.createSecretFile !== false) {
    write(fixture, 'secrets/ci.yaml', 'encrypted\n');
  }
  const result = runExecutable(
    'bash',
    fixture,
    [
      '-euo',
      'pipefail',
      '-c',
      yamlRunScript(SOPS_ACTION, 'Resolve and validate secret'),
    ],
    {
      CURL_MARKER: curlMarker,
      FAKE_SOPS: fakeSops,
      FAKE_SOPS_OUTPUT:
        options.sopsOutput ??
        JSON.stringify({
          ci: { standards_sync_token: 'resolved-token' },
        }),
      FAKE_SOPS_STATUS: String(options.sopsStatus ?? 0),
      GITHUB_ENV: environmentPath,
      GITHUB_OUTPUT: outputPath,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      RUNNER_TEMP: runnerTemp,
      SOPS_AGE_KEY: options.ageKey ?? 'age-secret-key',
      SOPS_ENV_NAME: 'GH_TOKEN',
      SOPS_SECRET_KEY: 'standards_sync_token',
      SOPS_FAILURE_MODE: options.failureMode ?? 'fallback',
      SOPS_FALLBACK_VALUE: options.fallbackValue ?? 'workflow-token',
      SOPS_SECRET_FILE: 'secrets/ci.yaml',
    },
  );
  return {
    curlCalled: existsSync(curlMarker),
    environment: existsSync(environmentPath)
      ? readFileSync(environmentPath, 'utf8')
      : '',
    output: existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '',
    result,
  };
};

// A fake upstream: its own manifest, a `template/` seed dir, two managed files.
const buildUpstream = (paths: ReadonlyArray<string> = STD_PATHS): string => {
  const up = mkTmp('sync-up-');
  write(
    up,
    'sync-standards.json',
    JSON.stringify({ upstream: up, seedDir: 'template', paths }),
  );
  write(up, 'template/seed.txt', 'seed original\n');
  write(up, 'template/AGENTS.local.md', '# Local\n');
  write(up, 'template/biome.jsonc', '{"extends":["./biome.base.jsonc"]}\n');
  write(
    up,
    '.github/dependabot.base.yml',
    [
      'version: 2',
      'updates:',
      '  - package-ecosystem: bun',
      '    directory: /',
      '    schedule:',
      '      interval: weekly',
      '  - package-ecosystem: github-actions',
      '    directory: /',
      '    schedule:',
      '      interval: weekly',
      '',
    ].join('\n'),
  );
  write(up, 'template/.github/dependabot.local.yml', '# no additions yet\n');
  write(
    up,
    'template/package.json',
    JSON.stringify({
      workspaces: ['apps/*'],
      scripts: {
        standards: 'standards',
        check:
          'standards check && turbo run lint check-types test build test:a11y',
        'check:fix':
          'standards check && turbo run lint:fix check-types test build test:a11y',
      },
      devDependencies: { '@davidvornholt/standards': '0.1.0' },
    }),
  );
  write(
    up,
    'template/apps/web/package.json',
    JSON.stringify({
      name: '@repo/web',
      version: '0.0.0',
      scripts: {
        'check-types': 'tsc --noEmit',
        lint: 'biome check --error-on-warnings .',
        'lint:fix': 'biome check --write --error-on-warnings .',
        test: 'bun test',
      },
    }),
  );
  write(
    up,
    'template/apps/web/tsconfig.json',
    '{ "extends": "@davidvornholt/typescript-config/base" }\n',
  );
  write(up, 'managed/a.txt', 'alpha\n');
  write(up, 'managed/b.txt', 'beta\n');
  return up;
};
const initConsumer = (up: string): { consumer: string; result: RunResult } => {
  const consumer = mkTmp('sync-cons-');
  const result = run(consumer, ['init', '--from', up, '--dir', consumer]);
  return { consumer, result };
};
const sync = (
  up: string,
  consumer: string,
  extra: ReadonlyArray<string> = [],
): RunResult =>
  run(consumer, ['sync', ...extra, '--from', up, '--dir', consumer]);

const git = (dir: string, args: ReadonlyArray<string>): string =>
  execFileSync(
    'git',
    [
      '-C',
      dir,
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { encoding: 'utf8' },
  ).trim();

const exerciseSeededGitignore = (
  consumer: string,
): {
  ignoredOutput: string;
  ignoredPaths: ReadonlyArray<string>;
  lockIgnoreStatus: number;
} => {
  const ignoredPaths = [
    'node_modules/package/index.js',
    '.turbo/cache/state',
    'dist/app.js',
    '.next/server/app.js',
    'debug.log',
    '.claude/worktrees/task/src/wip.ts',
  ];
  for (const path of ignoredPaths) {
    write(consumer, path, 'ignored\n');
  }
  const unignoredPath = 'src/not-ignored.ts';
  write(consumer, unignoredPath, 'export {};\n');
  const emptyExcludes = join(consumer, '.git/test-empty-global-excludes');
  write(consumer, '.git/test-empty-global-excludes', '');
  const isolatedExcludes = ['-c', `core.excludesFile=${emptyExcludes}`];
  const ignoredOutput = git(consumer, [
    ...isolatedExcludes,
    'check-ignore',
    '--',
    ...ignoredPaths,
    unignoredPath,
  ]);
  const lockIgnoreStatus = runExecutable('git', consumer, [
    '-C',
    consumer,
    ...isolatedExcludes,
    'check-ignore',
    '--quiet',
    '--',
    'sync-standards.lock',
  ]).status;
  return { ignoredOutput, ignoredPaths, lockIgnoreStatus };
};

// A git-backed upstream with two commits: tag `v1` and branch `stable` hold
// the original managed content while `main` has moved on. `file://` forces the
// remote-source code path that a plain local path would bypass.
const buildGitUpstream = (): {
  up: string;
  url: string;
  taggedSha: string;
} => {
  const up = buildUpstream();
  git(up, ['init', '--quiet', '-b', 'main']);
  git(up, ['add', '-A']);
  git(up, ['commit', '--quiet', '-m', 'v1']);
  git(up, ['tag', 'v1']);
  git(up, ['branch', 'stable']);
  const taggedSha = git(up, ['rev-parse', 'HEAD']);
  write(up, 'managed/a.txt', 'alpha v2\n');
  git(up, ['add', '-A']);
  git(up, ['commit', '--quiet', '-m', 'v2']);
  return { up, url: `file://${up}`, taggedSha };
};

const buildDependabotCutoverUpstream = (): {
  up: string;
  url: string;
} => {
  const up = buildUpstream();
  const base = read(up, '.github/dependabot.base.yml');
  rmSync(join(up, '.github/dependabot.base.yml'));
  git(up, ['init', '--quiet', '-b', 'main']);
  git(up, ['add', '-A']);
  git(up, ['commit', '--quiet', '-m', 'v0.10.0']);
  git(up, ['tag', 'v0.10.0']);
  write(up, '.github/dependabot.base.yml', base);
  git(up, ['add', '-A']);
  git(up, ['commit', '--quiet', '-m', 'v0.10.1']);
  return { up, url: `file://${up}` };
};

afterEach(() => {
  while (tmps.length > 0) {
    const dir = tmps.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('init', () => {
  it('rejects a source without the canonical Dependabot base before seeding', () => {
    const up = buildUpstream();
    rmSync(join(up, '.github/dependabot.base.yml'));
    const consumer = mkTmp('sync-cons-');
    write(consumer, 'seed.txt', 'mine\n');
    const before = snapshotTree(consumer);

    const result = run(consumer, ['init', '--from', up, '--dir', consumer]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires a 0.10.1-compatible content ref');
    expect(snapshotTree(consumer)).toEqual(before);
  });

  it('validates the effective overlay seed before changing the consumer', () => {
    const up = buildUpstream();
    write(
      up,
      'template/.github/dependabot.local.yml',
      'updates:\n  - package-ecosystem: bun\n    directory: /\n    schedule: { interval: daily }\n',
    );
    const consumer = mkTmp('sync-cons-');
    write(consumer, 'owned.txt', 'unchanged\n');
    const before = snapshotTree(consumer);

    const result = run(consumer, ['init', '--from', up, '--dir', consumer]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'may only add ignore or registries entries',
    );
    expect(snapshotTree(consumer)).toEqual(before);
  });

  it('seeds a template-only file, mirrors managed files, writes lock', () => {
    const { consumer, result } = initConsumer(buildUpstream());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('seeded seed.txt');
    expect(result.stdout).toContain('init complete:');
    expect(read(consumer, 'seed.txt')).toBe('seed original\n');
    expect(result.stdout).toContain('generated .github/dependabot.yml');
    expect(read(consumer, '.github/dependabot.yml')).toStartWith(
      '# GENERATED FILE',
    );
    expect(read(consumer, '.github/dependabot.yml')).toContain(
      'package-ecosystem: "bun"',
    );
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(readLock(consumer).files['managed/a.txt']).toBeDefined();
  });

  it('never clobbers a pre-existing seed destination', () => {
    const up = buildUpstream();
    const consumer = mkTmp('sync-cons-');
    write(consumer, 'seed.txt', 'mine\n');
    const result = run(consumer, ['init', '--from', up, '--dir', consumer]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('kept seed.txt (already present)');
    expect(read(consumer, 'seed.txt')).toBe('mine\n');
  });

  it('refuses to re-initialize when a lock already exists', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    write(consumer, 'managed/a.txt', 'local edit\n');
    const again = run(consumer, ['init', '--from', up, '--dir', consumer]);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('already initialized');
    expect(read(consumer, 'managed/a.txt')).toBe('local edit\n');
  });

  it('errors when a managed path overlaps a seed target', () => {
    const { consumer, result } = initConsumer(buildUpstream(['seed.txt']));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('overlaps seed path');
    expect(existsSync(join(consumer, 'sync-standards.lock'))).toBe(false);
  });

  it('seeds the actual template with empty workspace roots', () => {
    const { consumer, result } = initConsumer(ACTUAL_UPSTREAM);
    expect(result.status).toBe(0);
    expect(run(consumer, ['structure', '--dir', consumer]).status).toBe(0);
    git(consumer, ['init', '--quiet']);
    git(consumer, [
      'remote',
      'add',
      'origin',
      'https://github.com/davidvornholt/standards.git',
    ]);
    expect(run(consumer, ['check', '--dir', consumer]).status).toBe(0);
    expect(result.stdout).toContain('seeded .gitignore');
    expect(read(consumer, '.gitignore')).toBe(
      read(ACTUAL_UPSTREAM, 'template/.gitignore'),
    );
    const gitignore = exerciseSeededGitignore(consumer);
    expect(gitignore.ignoredOutput).toBe(gitignore.ignoredPaths.join('\n'));
    expect(gitignore.lockIgnoreStatus).toBe(1);
  });
});

describe('check', () => {
  it('passes right after init', () => {
    const { consumer } = initConsumer(buildUpstream());
    const check = run(consumer, ['check', '--dir', consumer]);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain(
      'canonical file(s) match the last synced state',
    );
  });

  it('fails and reports modified when a managed file is edited', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, 'managed/a.txt', 'tampered\n');
    const check = run(consumer, ['check', '--dir', consumer]);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain(
      'canonical file(s) drifted from the last synced state',
    );
    expect(check.stderr).toContain('modified: managed/a.txt');
  });

  it('fails and reports missing when a managed file is deleted', () => {
    const { consumer } = initConsumer(buildUpstream());
    rmSync(join(consumer, 'managed/a.txt'));
    const check = run(consumer, ['check', '--dir', consumer]);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('missing:  managed/a.txt');
  });

  it('fails closed when the lock is missing', () => {
    const consumer = mkTmp('sync-cons-');
    const check = run(consumer, ['check', '--dir', consumer]);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('no non-empty sync-standards.lock found');
  });

  it('aggregates malformed root JSON with independent gate problems', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, 'managed/a.txt', 'tampered\n');
    write(consumer, 'biome.jsonc', '{}\n');
    write(consumer, '.github/settings.json', '{"repository":{},"rulesets":[]}');
    write(
      consumer,
      '.github/settings.local.json',
      '{"repository":{},"rulesets":[]}',
    );
    write(consumer, 'package.json', '{ malformed');

    const check = run(import.meta.dir, ['check', '--dir', consumer]);

    expect(check.status).toBe(1);
    expect(check.stderr).toContain('modified: managed/a.txt');
    expect(check.stderr).toContain('biome.jsonc must extend');
    expect(check.stderr).toContain('package.json must contain valid JSON');
    expect(check.stderr).toContain(
      'package.json must exist and contain a JSON object',
    );
    expect(check.stderr).toContain(
      'cannot determine the GitHub repository from the origin remote',
    );
    expect(
      check.stderr.split('package.json must contain valid JSON'),
    ).toHaveLength(2);
    expect(check.stderr).not.toContain('JSON Parse error');
  });
});

describe('doctor', () => {
  it('reports every missing integration seam together', () => {
    const consumer = mkTmp('sync-cons-');
    write(consumer, 'package.json', '{}');
    const doctor = run(consumer, ['doctor', '--dir', consumer]);
    expect(doctor.status).toBe(1);
    expect(doctor.stderr).toContain('biome.jsonc must extend');
    expect(doctor.stderr).toContain('AGENTS.local.md must exist');
    expect(doctor.stderr).toContain('.github/dependabot.base.yml must exist');
    expect(doctor.stderr).toContain('@davidvornholt/standards');
    expect(doctor.stderr).toContain('script "check"');
    expect(doctor.stderr).toContain('script "check:fix"');
  });

  it('rejects non-executing standards check scripts', () => {
    const { consumer } = initConsumer(buildUpstream());
    const manifest = JSON.parse(read(consumer, 'package.json')) as {
      scripts: Record<string, string>;
    };
    manifest.scripts.check = 'echo standards check';
    manifest.scripts['check:fix'] = 'standards check --help';
    write(consumer, 'package.json', JSON.stringify(manifest));
    const doctor = run(consumer, ['doctor', '--dir', consumer]);
    expect(doctor.status).toBe(1);
    expect(doctor.stderr).toContain('script "check" must run standards check');
    expect(doctor.stderr).toContain(
      'script "check:fix" must run standards check',
    );
  });
});

describe('doctor Dependabot validation', () => {
  it('reports invalid Dependabot structure and missing baseline ecosystems', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(
      consumer,
      '.github/dependabot.base.yml',
      [
        'version: 1',
        'updates:',
        '  - package-ecosystem: nix',
        '    directory: /',
        '',
      ].join('\n'),
    );

    const doctor = run(consumer, ['doctor', '--dir', consumer]);

    expect(doctor.status).toBe(1);
    expect(doctor.stderr).toContain('must use version: 2');
    expect(doctor.stderr).toContain('must define schedule.interval');
    expect(doctor.stderr).toContain('root-directory bun ecosystem');
    expect(doctor.stderr).toContain('root-directory github-actions ecosystem');
  });

  it('reports malformed Dependabot YAML as an integration problem', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/dependabot.base.yml', 'version: [\n');

    const doctor = run(consumer, ['doctor', '--dir', consumer]);

    expect(doctor.status).toBe(1);
    expect(doctor.stderr).toContain(
      '.github/dependabot.base.yml must contain valid YAML',
    );
  });

  it('rejects unsupported and incomplete cron schedules', () => {
    const { consumer } = initConsumer(buildUpstream());
    const basePath = '.github/dependabot.base.yml';
    write(
      consumer,
      basePath,
      read(consumer, basePath)
        .replace('interval: weekly', 'interval: never')
        .replace('interval: weekly', 'interval: cron'),
    );

    const doctor = run(consumer, ['doctor', '--dir', consumer]);

    expect(doctor.status).toBe(1);
    expect(doctor.stderr).toContain('unsupported schedule.interval');
    expect(doctor.stderr).toContain('must define schedule.cronjob');
  });

  it('accepts additional ecosystems with a shared group schedule', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(
      consumer,
      '.github/dependabot.base.yml',
      [
        'version: 2',
        'multi-ecosystem-groups:',
        '  infrastructure:',
        '    schedule:',
        '      interval: weekly',
        'updates:',
        '  - package-ecosystem: bun',
        '    directory: /',
        '    schedule:',
        '      interval: weekly',
        '  - package-ecosystem: github-actions',
        '    directory: /',
        '    schedule:',
        '      interval: weekly',
        '  - package-ecosystem: nix',
        '    directories:',
        '      - /',
        '      - /infra',
        '    patterns: ["*"]',
        '    multi-ecosystem-group: infrastructure',
        '  - package-ecosystem: opentofu',
        '    directory: /infra',
        '    patterns: ["*"]',
        '    multi-ecosystem-group: infrastructure',
        '',
      ].join('\n'),
    );
    expect(
      run(consumer, ['dependabot', '--write', '--dir', consumer]).status,
    ).toBe(0);

    const doctor = run(consumer, ['doctor', '--dir', consumer]);

    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain('consumer integration seams are wired');
  });
});

describe('dependabot composition seam', () => {
  it('merges the repo-owned overlay into the generated file', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/dependabot.local.yml', DEPENDABOT_OVERLAY);

    const writeRun = run(consumer, [
      'dependabot',
      '--write',
      '--dir',
      consumer,
    ]);
    expect(writeRun.status).toBe(0);
    const generated = read(consumer, '.github/dependabot.yml');
    expect(generated).toContain('package-ecosystem: "nix"');
    expect(generated).toContain('dependency-name: "left-pad"');
    expect(run(consumer, ['doctor', '--dir', consumer]).status).toBe(0);
  });

  it('rejects an overlay that overrides a canonical block', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(
      consumer,
      '.github/dependabot.local.yml',
      [
        'updates:',
        '  - package-ecosystem: bun',
        '    directory: /',
        '    schedule:',
        '      interval: daily',
        '',
      ].join('\n'),
    );

    const writeRun = run(consumer, [
      'dependabot',
      '--write',
      '--dir',
      consumer,
    ]);
    expect(writeRun.status).toBe(1);
    expect(writeRun.stderr).toContain(
      'may only add ignore or registries entries',
    );
    const doctor = run(consumer, ['doctor', '--dir', consumer]);
    expect(doctor.status).toBe(1);
    expect(doctor.stderr).toContain(
      'may only add ignore or registries entries',
    );
  });

  it('flags a hand-edited generated file and repairs it with --write', () => {
    const { consumer } = initConsumer(buildUpstream());
    const before = read(consumer, '.github/dependabot.yml');
    write(consumer, '.github/dependabot.yml', `${before}# hand edit\n`);

    const check = run(consumer, ['dependabot', '--check', '--dir', consumer]);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('does not match its composed sources');
    expect(run(consumer, ['doctor', '--dir', consumer]).status).toBe(1);

    expect(
      run(consumer, ['dependabot', '--write', '--dir', consumer]).status,
    ).toBe(0);
    expect(read(consumer, '.github/dependabot.yml')).toBe(before);
    expect(run(consumer, ['dependabot', '--dir', consumer]).status).toBe(0);
  });

  it('regenerates the composed file on sync after the overlay changes', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    write(consumer, '.github/dependabot.local.yml', DEPENDABOT_OVERLAY);

    const dry = run(consumer, [
      'sync',
      '--from',
      up,
      '--dir',
      consumer,
      '--dry-run',
    ]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('would generate .github/dependabot.yml');
    expect(read(consumer, '.github/dependabot.yml')).not.toContain('nix');

    const syncRun = run(consumer, ['sync', '--from', up, '--dir', consumer]);
    expect(syncRun.status).toBe(0);
    expect(syncRun.stdout).toContain('generated .github/dependabot.yml');
    expect(read(consumer, '.github/dependabot.yml')).toContain(
      'package-ecosystem: "nix"',
    );
  });
});

describe('structure', () => {
  const tsconfigProblem =
    'apps/web: tsconfig.json must extend @davidvornholt/typescript-config';

  it('check rejects non-executing root gate modes', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(
      consumer,
      'package.json',
      JSON.stringify({
        workspaces: ['apps/*'],
        scripts: {
          check:
            'standards check && turbo run lint check-types test build test:a11y --dry',
          'check:fix':
            'standards check && turbo run lint:fix check-types test build test:a11y --version',
        },
        devDependencies: { '@davidvornholt/standards': '0.1.0' },
      }),
    );
    const check = run(consumer, ['check', '--dir', consumer]);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('monorepo structure problem(s)');
    expect(check.stderr).toContain('root script "check" must run');
    expect(check.stderr).toContain('root script "check:fix" must run');
  });

  it('the structure command validates structure in isolation', () => {
    const { consumer } = initConsumer(buildUpstream());
    const ok = run(consumer, ['structure', '--dir', consumer]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('workspace layout matches the standards');
  });

  it('the source checkout passes its own source profile', () => {
    const result = run(ACTUAL_UPSTREAM, [
      'structure',
      '--profile',
      'source',
      '--dir',
      ACTUAL_UPSTREAM,
    ]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('rejects an unknown structure profile', () => {
    const consumer = mkTmp('sync-cons-');
    const result = run(consumer, ['structure', '--profile', 'strict']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--profile must be "consumer" or "source"');
  });

  it('rejects --profile outside the structure command', () => {
    const consumer = mkTmp('sync-cons-');
    const result = run(consumer, ['doctor', '--profile', 'source']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '--profile is only valid with the structure command',
    );
  });

  it.each([
    [
      'commented-out',
      '{ // "extends": "@davidvornholt/typescript-config/base"\n}',
    ],
    [
      'nested',
      '{"compilerOptions":{"extends":"@davidvornholt/typescript-config/base"}}',
    ],
    ['lookalike scope', '{"extends":"@other/typescript-config/base"}'],
    [
      'lookalike name',
      '{"extends":"@davidvornholt/typescript-config-copy/base"}',
    ],
    ['empty export', '{"extends":"@davidvornholt/typescript-config/"}'],
    [
      'traversal export',
      '{"extends":"@davidvornholt/typescript-config/../evil"}',
    ],
    ['malformed', '{"extends":"@davidvornholt/typescript-config/base"'],
  ])('rejects %s tsconfig inheritance', (_label, tsconfig) => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, 'apps/web/tsconfig.json', tsconfig);
    const result = run(consumer, ['structure', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(tsconfigProblem);
  });

  it.each([
    [
      'JSONC string',
      '{ // shared strict defaults\n"extends":"@davidvornholt/typescript-config/base",\n}',
    ],
    [
      'extends array',
      '{"extends":["./generated.json","@davidvornholt/typescript-config/next"]}',
    ],
  ])('accepts canonical inheritance through a %s', (_label, tsconfig) => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, 'apps/web/tsconfig.json', tsconfig);
    expect(run(consumer, ['structure', '--dir', consumer]).status).toBe(0);
  });
});

describe('prospective Dependabot sync', () => {
  it('rejects an incoming source without the Dependabot base before mutation', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    rmSync(join(up, '.github/dependabot.base.yml'));
    write(up, 'managed/a.txt', 'alpha v2\n');
    const before = snapshotTree(consumer);

    const result = sync(up, consumer);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires a 0.10.1-compatible content ref');
    expect(snapshotTree(consumer)).toEqual(before);
  });

  it('validates an incoming base against the overlay before every mutation', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    write(
      consumer,
      '.github/dependabot.local.yml',
      [
        'updates:',
        '  - package-ecosystem: nix',
        '    directory: /',
        '    schedule: { interval: weekly }',
        '',
      ].join('\n'),
    );
    write(up, 'managed/a.txt', 'alpha v2\n');
    rmSync(join(up, 'managed/b.txt'));
    write(up, 'managed/new.txt', 'new\n');
    write(
      up,
      '.github/dependabot.base.yml',
      `${read(up, '.github/dependabot.base.yml')}  - package-ecosystem: nix\n    directory: /\n    schedule: { interval: weekly }\n`,
    );
    const before = snapshotTree(consumer);

    const dry = sync(up, consumer, ['--dry-run']);
    const real = sync(up, consumer);

    expect(dry.status).toBe(1);
    expect(real.status).toBe(1);
    expect(dry.stderr).toContain('may only add ignore or registries entries');
    expect(real.stderr).toContain('may only add ignore or registries entries');
    expect(snapshotTree(consumer)).toEqual(before);
  });

  it('dry-run composes the incoming base and reports its generated change', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    const before = snapshotTree(consumer);
    write(
      up,
      '.github/dependabot.base.yml',
      `${read(up, '.github/dependabot.base.yml')}  - package-ecosystem: nix\n    directory: /\n    schedule: { interval: weekly }\n`,
    );

    const dry = sync(up, consumer, ['--dry-run']);

    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('would update .github/dependabot.base.yml');
    expect(dry.stdout).toContain('would generate .github/dependabot.yml');
    expect(snapshotTree(consumer)).toEqual(before);
  });
});

describe('sync', () => {
  it('uses new managed paths from the upstream manifest immediately', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    write(up, 'newly-managed.txt', 'new\n');
    write(
      up,
      'sync-standards.json',
      JSON.stringify({
        upstream: up,
        seedDir: 'template',
        paths: [...STD_PATHS, 'newly-managed.txt'],
      }),
    );

    const result = sync(up, consumer);

    expect(result.status).toBe(0);
    expect(read(consumer, 'newly-managed.txt')).toBe('new\n');
    expect(readLock(consumer).files['newly-managed.txt']).toBeDefined();
    expect(sync(up, consumer, ['--dry-run']).stdout).toContain(
      'dry run: already in sync; no changes',
    );
  });

  it('deletes a consumer file removed from upstream and prunes the lock', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    rmSync(join(up, 'managed/b.txt'));
    const result = sync(up, consumer);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('deleted managed/b.txt (removed upstream)');
    expect(existsSync(join(consumer, 'managed/b.txt'))).toBe(false);
    expect(readLock(consumer).files['managed/b.txt']).toBeUndefined();
  });

  it('updates a changed upstream file and check passes afterward', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    write(up, 'managed/a.txt', 'alpha v2\n');
    const result = sync(up, consumer);
    expect(result.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha v2\n');
    expect(run(consumer, ['check', '--dir', consumer]).status).toBe(0);
  });

  it('dry-run writes nothing, then a real sync applies the change', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    const lockBefore = read(consumer, 'sync-standards.lock');
    write(up, 'managed/a.txt', 'alpha v2\n');
    const dry = sync(up, consumer, ['--dry-run']);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('would update managed/a.txt');
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
    sync(up, consumer);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha v2\n');
  });

  it('dry-run reports no changes when already in sync', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    const dry = sync(up, consumer, ['--dry-run']);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('dry run: already in sync; no changes');
  });
});

describe('Dependabot content ref cutover', () => {
  it('rejects the v0.10.0 pinned ref before init or sync mutation', () => {
    const { up, url } = buildDependabotCutoverUpstream();

    const initTarget = mkTmp('sync-cons-');
    write(initTarget, 'owned.txt', 'unchanged\n');
    const initBefore = snapshotTree(initTarget);
    const initResult = run(initTarget, [
      'init',
      '--from',
      url,
      '--ref',
      'v0.10.0',
      '--dir',
      initTarget,
    ]);
    expect(initResult.status).toBe(1);
    expect(initResult.stderr).toContain(
      'requires a 0.10.1-compatible content ref',
    );
    expect(snapshotTree(initTarget)).toEqual(initBefore);

    const { consumer } = initConsumer(up);
    const syncBefore = snapshotTree(consumer);
    const syncResult = sync(url, consumer, ['--ref', 'v0.10.0']);
    expect(syncResult.status).toBe(1);
    expect(syncResult.stderr).toContain(
      'requires a 0.10.1-compatible content ref',
    );
    expect(snapshotTree(consumer)).toEqual(syncBefore);
  });
});

describe('ref pinning', () => {
  it('syncs the tagged snapshot with --ref and main without it', () => {
    const { up, url, taggedSha } = buildGitUpstream();
    const { consumer } = initConsumer(up);

    const pinned = sync(url, consumer, ['--ref', 'v1']);
    expect(pinned.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(readLock(consumer).sha).toBe(taggedSha);

    const tracking = sync(url, consumer);
    expect(tracking.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha v2\n');
  });

  it('syncs a raw commit sha and records the exact pin', () => {
    const { up, url, taggedSha } = buildGitUpstream();
    const { consumer } = initConsumer(up);

    const result = sync(url, consumer, ['--ref', taggedSha]);

    expect(result.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(readLock(consumer).sha).toBe(taggedSha);
  });

  it('syncs a named non-default branch', () => {
    const { up, url, taggedSha } = buildGitUpstream();
    const { consumer } = initConsumer(up);

    const result = sync(url, consumer, ['--ref', 'stable']);

    expect(result.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(readLock(consumer).sha).toBe(taggedSha);
  });

  it('init honors --ref for a pinned first mirror', () => {
    const { url, taggedSha } = buildGitUpstream();
    const consumer = mkTmp('sync-cons-');
    const result = run(consumer, [
      'init',
      '--from',
      url,
      '--ref',
      'v1',
      '--dir',
      consumer,
    ]);
    expect(result.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(readLock(consumer).sha).toBe(taggedSha);
  });

  it('fails with an actionable error for an unknown ref', () => {
    const { up, url } = buildGitUpstream();
    const { consumer } = initConsumer(up);
    const result = sync(url, consumer, ['--ref', 'v9']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cannot fetch "v9"');
  });

  it('rejects an option-like ref without changing the consumer', () => {
    const { up, url } = buildGitUpstream();
    const { consumer } = initConsumer(up);
    const managedBefore = read(consumer, 'managed/a.txt');
    const lockBefore = read(consumer, 'sync-standards.lock');

    const result = sync(url, consumer, ['--ref', '-u']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cannot fetch "-u"');
    expect(read(consumer, 'managed/a.txt')).toBe(managedBefore);
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
  });

  it('rejects --ref combined with a local path source', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    const result = sync(up, consumer, ['--ref', 'v1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--ref requires a git URL source');
  });

  it('rejects --ref outside init and sync', () => {
    const consumer = mkTmp('sync-cons-');
    const result = run(consumer, ['check', '--ref', 'v1', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '--ref is only valid with the init and sync commands',
    );
  });
});

describe('sync policy file', () => {
  it('sync honors a checked-in pin and an explicit --ref overrides it', () => {
    const { up, url, taggedSha } = buildGitUpstream();
    const { consumer } = initConsumer(up);
    write(consumer, 'sync-standards.local.json', '{ "ref": "v1" }\n');

    const pinned = sync(url, consumer);
    expect(pinned.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(readLock(consumer).sha).toBe(taggedSha);

    const overridden = sync(url, consumer, ['--ref', 'main']);
    expect(overridden.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha v2\n');
  });

  it('init honors a checked-in pin for the first mirror', () => {
    const { url, taggedSha } = buildGitUpstream();
    const consumer = mkTmp('sync-cons-');
    write(consumer, 'sync-standards.local.json', '{ "ref": "v1" }\n');
    const result = run(consumer, ['init', '--from', url, '--dir', consumer]);
    expect(result.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(readLock(consumer).sha).toBe(taggedSha);
  });

  it('ignores the pin for a local-path source, which is used as-is', () => {
    const { up } = buildGitUpstream();
    const { consumer } = initConsumer(up);
    write(consumer, 'sync-standards.local.json', '{ "ref": "v1" }\n');
    const result = sync(up, consumer);
    expect(result.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha v2\n');
  });
});

describe('sync policy validation', () => {
  it.each(
    INVALID_POLICY_CASES,
  )('validates %s before explicit refs and local sources', (_label, policy, expectedError) => {
    const { up, url } = buildGitUpstream();
    const { consumer } = initConsumer(up);
    write(consumer, 'sync-standards.local.json', policy);

    for (const extra of [
      ['--ref', 'main'],
      ['--ref', 'main', '--dry-run'],
    ]) {
      const result = sync(url, consumer, extra);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(expectedError);
    }

    const localSync = sync(up, consumer);
    expect(localSync.status).toBe(1);
    expect(localSync.stderr).toContain(expectedError);

    for (const source of [url, up]) {
      const initTarget = mkTmp('sync-cons-');
      write(initTarget, 'sync-standards.local.json', policy);
      const args =
        source === url
          ? ['init', '--from', source, '--ref', 'main', '--dir', initTarget]
          : ['init', '--from', source, '--dir', initTarget];
      const result = run(initTarget, args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(expectedError);
    }
  });

  it.each(
    INVALID_POLICY_CASES,
  )('doctor and check reject %s', (_label, policy, expectedError) => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, 'sync-standards.local.json', policy);

    for (const command of ['doctor', 'check']) {
      const result = run(consumer, [command, '--dir', consumer]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(expectedError);
    }
  });

  it('doctor and check accept a valid policy', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(
      consumer,
      'sync-standards.local.json',
      '{ "autoSync": false, "ref": "v1" }\n',
    );

    expect(run(consumer, ['doctor', '--dir', consumer]).status).toBe(0);
    expect(run(consumer, ['check', '--dir', consumer]).status).toBe(0);
  });
});

type PackedCliInstallation = {
  readonly consumer: string;
  readonly help: RunResult;
  readonly sourceProfile: RunResult;
};

type ExecutableRunner = typeof runExecutable;

const requireSuccessfulStage = (stage: string, result: RunResult): void => {
  if (result.status !== 0) {
    throw new Error(`${stage} failed: ${result.stderr}`);
  }
};

const installPackedCli = (
  execute: ExecutableRunner = runExecutable,
): PackedCliInstallation => {
  const packed = mkTmp('standards-pack-');
  const pack = execute('bun', join(import.meta.dir, '..'), [
    'pm',
    'pack',
    '--destination',
    packed,
    '--quiet',
  ]);
  requireSuccessfulStage('pack', pack);
  const tarball = pack.stdout.trim();
  if (tarball.length === 0) {
    throw new Error('pack succeeded without reporting a tarball');
  }

  const consumer = mkTmp('sync-cons-');
  write(
    consumer,
    'package.json',
    JSON.stringify({
      version: '0.0.0',
      private: true,
      workspaces: ['apps/*'],
      scripts: {
        standards: 'standards',
        check:
          'standards check && turbo run lint check-types test build test:a11y',
        'check:fix':
          'standards check && turbo run lint:fix check-types test build test:a11y',
      },
      devDependencies: {
        '@davidvornholt/standards': `file:${tarball}`,
      },
    }),
  );
  const install = execute('bun', consumer, ['install', '--ignore-scripts']);
  requireSuccessfulStage('install', install);

  const help = execute('bun', consumer, ['standards', 'help']);
  const sourceProfile = execute('bun', consumer, [
    'standards',
    'structure',
    '--profile',
    'source',
    '--dir',
    ACTUAL_UPSTREAM,
  ]);
  return { consumer, help, sourceProfile };
};

describe('packed artifact prerequisite staging', () => {
  it.each([
    ['pack', 1],
    ['install', 2],
  ] as const)('does not execute later stages after %s fails', (_stage, failureCall) => {
    let calls = 0;
    const execute: ExecutableRunner = () => {
      calls += 1;
      return {
        stdout: calls === 1 ? '/tmp/standards.tgz\n' : '',
        stderr: '',
        status: calls === failureCall ? 1 : 0,
      };
    };

    expect(() => installPackedCli(execute)).toThrow();
    expect(calls).toBe(failureCall);
  });
});

describe('packed artifact content ref cutover', () => {
  it('rejects v0.10.0 content before packed init or sync mutation', () => {
    const { consumer: runner } = installPackedCli();
    const { up, url } = buildDependabotCutoverUpstream();
    const execute = (args: ReadonlyArray<string>, target: string): RunResult =>
      runExecutable('bun', runner, ['standards', ...args, '--dir', target]);

    const initTarget = mkTmp('sync-cons-');
    write(initTarget, 'owned.txt', 'unchanged\n');
    const initBefore = snapshotTree(initTarget);
    const initResult = execute(
      ['init', '--from', url, '--ref', 'v0.10.0'],
      initTarget,
    );
    expect(initResult.status).toBe(1);
    expect(initResult.stderr).toContain(
      'requires a 0.10.1-compatible content ref',
    );
    expect(snapshotTree(initTarget)).toEqual(initBefore);

    const syncTarget = mkTmp('sync-cons-');
    expect(execute(['init', '--from', up], syncTarget).status).toBe(0);
    const syncBefore = snapshotTree(syncTarget);
    const syncResult = execute(
      ['sync', '--from', url, '--ref', 'v0.10.0'],
      syncTarget,
    );
    expect(syncResult.status).toBe(1);
    expect(syncResult.stderr).toContain(
      'requires a 0.10.1-compatible content ref',
    );
    expect(snapshotTree(syncTarget)).toEqual(syncBefore);
  });
});

describe('packed artifact distribution', () => {
  it('ships the Dependabot contract and honors the workflow sync pin', () => {
    const packageManifest = JSON.parse(
      readFileSync(join(import.meta.dir, '../package.json'), 'utf8'),
    ) as { version: string };
    const templateManifest = JSON.parse(
      readFileSync(join(ACTUAL_UPSTREAM, 'template/package.json'), 'utf8'),
    ) as { devDependencies: Record<string, string> };
    expect(templateManifest.devDependencies['@davidvornholt/standards']).toBe(
      packageManifest.version,
    );
    const installation = installPackedCli();
    expect(installation.help.status).toBe(0);
    expect(installation.help.stdout).toContain(
      'dependabot  Verify (--check) or regenerate (--write)',
    );
    expect(installation.sourceProfile.stderr).toBe('');
    expect(installation.sourceProfile.status).toBe(0);

    const { consumer } = installation;
    const { up, url } = buildGitUpstream();
    const command = (name: 'check' | 'dependabot'): RunResult =>
      runExecutable('bun', consumer, [
        'standards',
        name,
        ...(name === 'dependabot' ? ['--check'] : []),
        '--dir',
        consumer,
      ]);
    expect(
      runExecutable('bun', consumer, [
        'standards',
        'init',
        '--from',
        up,
        '--dir',
        consumer,
      ]).status,
    ).toBe(0);
    write(consumer, '.github/dependabot.local.yml', DEPENDABOT_OVERLAY);
    expect(
      runExecutable('bun', consumer, [
        'standards',
        'dependabot',
        '--write',
        '--dir',
        consumer,
      ]).status,
    ).toBe(0);
    const composed = read(consumer, '.github/dependabot.yml');
    expect(composed).toContain('package-ecosystem: "nix"');
    expect(composed).toContain('dependency-name: "left-pad"');
    expect(command('dependabot').status).toBe(0);
    write(consumer, '.github/dependabot.yml', `${composed}# generated drift\n`);
    for (const driftCheck of (['dependabot', 'check'] as const).map(command)) {
      expect(driftCheck.status).toBe(1);
      expect(driftCheck.stderr).toContain(
        'does not match its composed sources',
      );
    }
    write(consumer, 'sync-standards.local.json', '{ "ref": "v1" }\n');
    expect(
      runExecutable('bun', consumer, [
        'standards',
        'sync',
        '--from',
        url,
        '--dir',
        consumer,
      ]).status,
    ).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(read(consumer, '.github/dependabot.yml')).toBe(composed);
    expect(command('check').status).toBe(0);
  });
});

describe('canonical standards workflow security boundaries', () => {
  it('isolates the admin-read token from repository-controlled executable code', () => {
    const workflow = readFileSync(STANDARDS_WORKFLOW, 'utf8');
    const installStep = yamlStep(
      STANDARDS_WORKFLOW,
      'Install pinned settings checker',
    );
    const settingsStep = yamlStep(STANDARDS_WORKFLOW, 'Check GitHub settings');
    expect(workflow).not.toContain('uses: ./.github/actions/sops-secret');
    expect(workflow).not.toContain('GITHUB_ENV');
    expect(workflow).not.toContain('GH_TOKEN:');
    expect(settingsStep).not.toContain('GITHUB_OUTPUT');
    expect(settingsStep).toContain('GH_TOKEN="$value"');
    expect(workflow).toContain('STANDARDS_SKIP_GITHUB_CHECK: "true"');
    expect(workflow).toContain('.github/settings.json');
    expect(workflow).toContain('.github/settings.local.json');
    expect(workflow).toContain('secrets/ci.yaml');
    expect(workflow).toContain('sparse-checkout-cone-mode: false');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain(
      'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0',
    );
    expect(installStep).toContain('bun_version=1.3.14');
    expect(installStep.match(/bun_sha=[a-f0-9]{64}/gu)).toHaveLength(2);
    expect(installStep).toContain('standards_version=0.10.1');
    expect(installStep).toContain('yaml_version=2.9.0');
    expect(installStep.match(/sha=[a-f0-9]{128}/gu)).toHaveLength(2);
    expect(installStep).toContain('sha512sum --check --quiet');
    expect(installStep).not.toContain('bun add');
    expect(settingsStep).toContain(
      `--extract '["ci"]["github_settings_read_token"]'`,
    );
    expect(settingsStep).toContain('unset SOPS_AGE_KEY FALLBACK_TOKEN');
  });

  it('pins and verifies architecture-specific actionlint release assets', () => {
    const lintStep = yamlStep(STANDARDS_WORKFLOW, 'Lint workflows');
    expect(lintStep).toContain('version=1.7.12');
    expect(lintStep.match(/sha=[a-f0-9]{64}/gu)).toHaveLength(2);
    expect(lintStep).toMatch(ACTIONLINT_ASSET_PATTERN);
    expect(lintStep).toContain('sha256sum --check --quiet');
    expect(lintStep).not.toContain('download-actionlint.bash');
    expect(lintStep).not.toContain(' latest ');
  });

  it('keeps the required check name fail-closed over both isolated jobs', () => {
    const workflow = readFileSync(STANDARDS_WORKFLOW, 'utf8');
    expect(workflow).toContain('  quality:');
    expect(workflow).toContain('  github-settings:');
    expect(workflow).toContain('  check:');
    expect(workflow).toContain('    if: always()');
    expect(workflow).toContain('      - quality');
    expect(workflow).toContain('      - github-settings');
    expect(workflow).toContain(
      'if [ "$QUALITY_RESULT" != success ] || [ "$GITHUB_SETTINGS_RESULT" != success ]; then',
    );
  });
});

describe('canonical SOPS secret action', () => {
  it('exports a decrypted non-empty single-line string', () => {
    const actionRun = runSopsAction();

    expect(actionRun.result.status).toBe(0);
    expect(actionRun.environment).toBe('GH_TOKEN=resolved-token\n');
    expect(actionRun.output).toBe('used-fallback=false\n');
    expect(actionRun.result.stdout).toContain('::add-mask::resolved-token');
    expect(actionRun.curlCalled).toBe(true);
  });

  it.each([
    ['an empty string', ''],
    ['a line-feed string', 'token\nBASH_ENV=/tmp/payload'],
    ['a carriage-return string', 'token\rGH_TOKEN=payload'],
    ['a non-scalar value', { token: 'value' }],
  ])('rejects %s before exporting it', (_label, sopsValue) => {
    const actionRun = runSopsAction({
      sopsOutput: JSON.stringify({
        ci: { standards_sync_token: sopsValue },
      }),
    });

    expect(actionRun.result.status).toBe(0);
    expect(actionRun.environment).toBe('GH_TOKEN=workflow-token\n');
    expect(actionRun.output).toBe('used-fallback=true\n');
    expect(actionRun.environment).not.toContain('payload');
  });

  it('uses the fallback when decryption fails', () => {
    const actionRun = runSopsAction({ sopsStatus: 1 });

    expect(actionRun.result.status).toBe(0);
    expect(actionRun.environment).toBe('GH_TOKEN=workflow-token\n');
    expect(actionRun.output).toBe('used-fallback=true\n');
  });

  it.each([
    ['the age key is absent', { ageKey: '' }],
    ['the secret file is absent', { createSecretFile: false }],
  ] as const)('uses the fallback without downloading when %s', (_label, input) => {
    const actionRun = runSopsAction(input);

    expect(actionRun.result.status).toBe(0);
    expect(actionRun.environment).toBe('GH_TOKEN=workflow-token\n');
    expect(actionRun.output).toBe('used-fallback=true\n');
    expect(actionRun.curlCalled).toBe(false);
  });

  it('fails closed for a required invalid secret', () => {
    const actionRun = runSopsAction({
      failureMode: 'fail',
      sopsOutput: JSON.stringify({
        ci: { standards_sync_token: 'token\nGH_TOKEN=payload' },
      }),
    });

    expect(actionRun.result.status).toBe(1);
    expect(actionRun.environment).toBe('');
    expect(`${actionRun.result.stdout}${actionRun.result.stderr}`).toContain(
      '::error::',
    );
  });

  it('rejects an invalid fallback before the environment boundary', () => {
    const actionRun = runSopsAction({
      ageKey: '',
      fallbackValue: 'token\nBASH_ENV=/tmp/payload',
    });

    expect(actionRun.result.status).toBe(1);
    expect(actionRun.environment).toBe('');
  });

  it('serves workflows that can safely execute the checked-out local action', () => {
    const action = readFileSync(SOPS_ACTION, 'utf8');
    const canonicalActionPath = '.github/actions/sops-secret/action.yml';
    const productionFiles = readProductionGithubFiles();
    const versionOwners = productionFiles
      .filter(({ content }) => content.match(SOPS_VERSION_ASSIGNMENT) !== null)
      .map(({ path }) => path);
    const checksumOwners = productionFiles
      .filter(({ content }) => content.match(SOPS_CHECKSUM_ASSIGNMENT) !== null)
      .map(({ path }) => path);
    const localActionWorkflows = [
      readFileSync(SYNC_WORKFLOW, 'utf8'),
      readFileSync(NOTIFY_WORKFLOW, 'utf8'),
    ];
    const isolatedWorkflow = readFileSync(STANDARDS_WORKFLOW, 'utf8');
    expect(action.match(SOPS_VERSION_ASSIGNMENT)).toHaveLength(1);
    expect(action.match(SOPS_CHECKSUM_ASSIGNMENT)).toHaveLength(2);
    expect(versionOwners).toEqual([
      '.github/workflows/standards.yml',
      canonicalActionPath,
    ]);
    expect(checksumOwners).toEqual([
      '.github/workflows/standards.yml',
      canonicalActionPath,
    ]);
    for (const workflow of localActionWorkflows) {
      expect(workflow).toContain('uses: ./.github/actions/sops-secret');
    }
    expect(isolatedWorkflow).not.toContain(
      'uses: ./.github/actions/sops-secret',
    );
    expect(isolatedWorkflow).toContain('sops_version=v3.13.2');
    expect(isolatedWorkflow.match(/sops_sha=[a-f0-9]{64}/gu)).toHaveLength(2);
    const syncManifest = JSON.parse(
      readFileSync(join(ACTUAL_UPSTREAM, 'sync-standards.json'), 'utf8'),
    ) as { readonly paths: ReadonlyArray<string> };
    expect(syncManifest.paths).toContain('.github/actions/sops-secret');
  });
});

describe('canonical SOPS missing-key modes', () => {
  it('uses one validated fallback record when the requested key is absent', () => {
    const actionRun = runSopsAction({
      sopsOutput: JSON.stringify({ ci: {} }),
    });

    expect(actionRun.result.status).toBe(0);
    expect(actionRun.environment).toBe('GH_TOKEN=workflow-token\n');
    expect(actionRun.output).toBe('used-fallback=true\n');
    expect(actionRun.curlCalled).toBe(true);
  });

  it('fails without exported records when a required key is absent', () => {
    const actionRun = runSopsAction({
      failureMode: 'fail',
      sopsOutput: JSON.stringify({ ci: {} }),
    });

    expect(actionRun.result.status).toBe(1);
    expect(actionRun.environment).toBe('');
    expect(actionRun.output).toBe('');
  });
});

describe('standards sync workflow ordering', () => {
  it('stops a clean mirror before token resolution', () => {
    const fixture = mkTmp('sync-clean-');
    const outputPath = join(mkTmp('sync-output-'), 'github-output');
    expect(runExecutable('git', fixture, ['init', '--quiet']).status).toBe(0);

    const result = runExecutable(
      'bash',
      fixture,
      ['-euo', 'pipefail', '-c', workflowRunScript('Detect mirror changes')],
      { GITHUB_OUTPUT: outputPath },
    );
    const workflow = readFileSync(SYNC_WORKFLOW, 'utf8');
    const detectIndex = workflow.indexOf('- name: Detect mirror changes');
    const resolveIndex = workflow.indexOf('- name: Resolve sync PR token');
    const resolveStep = yamlStep(SYNC_WORKFLOW, 'Resolve sync PR token');
    const parsedResolveStep: unknown = parseYaml(resolveStep);
    if (
      !Array.isArray(parsedResolveStep) ||
      parsedResolveStep.length !== 1 ||
      typeof parsedResolveStep[0] !== 'object' ||
      parsedResolveStep[0] === null
    ) {
      throw new Error('Resolve sync PR token must parse as one YAML step');
    }
    const resolveGuard = (parsedResolveStep[0] as Record<string, unknown>).if;

    expect(result.status).toBe(0);
    expect(readFileSync(outputPath, 'utf8')).toBe('changed=false\n');
    expect(result.stdout).toContain('Already in sync');
    expect(detectIndex).toBeGreaterThan(-1);
    expect(resolveIndex).toBeGreaterThan(detectIndex);
    expect(resolveGuard).toBe("steps.mirror.outputs.changed == 'true'");
  });
});

describe('standards sync workflow policy', () => {
  const runPolicyPreflight = (
    policy: string | undefined,
    legacy: Readonly<Record<string, string>> = {},
  ): { result: RunResult; output: string } => {
    const fixture = mkTmp('sync-policy-');
    if (policy !== undefined) {
      write(fixture, 'sync-standards.local.json', policy);
    }
    const outputPath = join(fixture, 'github-output');
    const result = runExecutable(
      'bash',
      fixture,
      ['-euo', 'pipefail', '-c', workflowRunScript('Read sync policy')],
      { GITHUB_OUTPUT: outputPath, ...legacy },
    );
    return {
      result,
      output: existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '',
    };
  };

  it('uses defaults when the policy is absent and ignores legacy variables', () => {
    const { result, output } = runPolicyPreflight(undefined, {
      STANDARDS_AUTO_SYNC: 'false',
      STANDARDS_SYNC_REF: 'v0.6.0',
    });

    expect(result.status).toBe(0);
    expect(output).toContain('auto-sync=true');
    expect(output).toContain('present=false');
    expect(output).toContain('ref=\n');
    expect(readFileSync(SYNC_WORKFLOW, 'utf8')).not.toContain(
      'STANDARDS_AUTO_SYNC',
    );
    expect(readFileSync(SYNC_WORKFLOW, 'utf8')).not.toContain(
      'STANDARDS_SYNC_REF',
    );
  });

  it('emits a validated opt-out and pin while manual dispatch stays enabled', () => {
    const { result, output } = runPolicyPreflight(
      '{ "autoSync": false, "ref": "v0.7.0" }\n',
    );

    expect(result.status).toBe(0);
    expect(output).toContain('auto-sync=false');
    expect(output).toContain('present=true');
    expect(output).toContain('ref=v0.7.0');
    expect(readFileSync(SYNC_WORKFLOW, 'utf8')).toContain(
      "if: github.event_name == 'workflow_dispatch' || needs.policy.outputs.auto-sync != 'false'",
    );
  });

  it.each([
    ['malformed JSON', 'not json'],
    ['a null root', 'null'],
    ['an array root', '[]'],
    ['a wrong autoSync type', '{ "autoSync": "false" }'],
    ['a numeric autoSync', '{ "autoSync": 0 }'],
    ['a wrong ref type', '{ "ref": 1 }'],
    ['an empty ref', '{ "ref": "" }'],
    ['a newline in ref', '{ "ref": "main\\npresent=false" }'],
    ['a carriage return in ref', '{ "ref": "main\\rpresent=false" }'],
    ['an unsupported field', '{ "branch": "stable" }'],
  ])('fails closed for %s', (_label, policy) => {
    const { result, output } = runPolicyPreflight(policy);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'sync-standards.local.json must be an object',
    );
    expect(output).toBe('');
  });

  it.each([
    '0.9.0',
    '0.10.0',
    '0.10.1',
    '0.10.0-beta.1',
  ])('rejects installed CLI version %s without a policy file', (version) => {
    const result = runWorkflowVersionGuard(version);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('::error::');
  });

  it('makes the 0.10.2 guard unconditional', () => {
    const workflow = readFileSync(SYNC_WORKFLOW, 'utf8');
    expect(workflow).not.toContain(
      "if: needs.policy.outputs.present == 'true'",
    );
  });

  it.each([
    '0.10.2',
    '0.11.0',
  ])('accepts installed CLI version %s without a policy file', (version) => {
    expect(runWorkflowVersionGuard(version).status).toBe(0);
  });
});

describe('github', () => {
  const EmptySeam = JSON.stringify({ repository: {}, rulesets: [] });
  const Canonical = JSON.stringify({
    repository: { allow_auto_merge: true },
    rulesets: [{ name: 'Protect main', target: 'branch' }],
  });

  it('fails when the canonical declaration is missing', () => {
    const { consumer } = initConsumer(buildUpstream());
    const result = run(consumer, ['github', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.github/settings.json not found');
  });

  it('fails closed when the origin remote cannot be resolved', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', Canonical);
    write(consumer, '.github/settings.local.json', EmptySeam);
    const result = run(consumer, ['github', '--check', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'cannot determine the GitHub repository from the origin remote',
    );
  });

  it('apply also requires a resolvable origin remote', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', Canonical);
    write(consumer, '.github/settings.local.json', EmptySeam);
    const result = run(consumer, ['github', '--apply', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'cannot determine the GitHub repository from the origin remote',
    );
  });

  it('check gates on the declaration once it is present', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', Canonical);
    write(consumer, '.github/settings.local.json', EmptySeam);
    const result = run(consumer, ['check', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'cannot determine the GitHub repository from the origin remote',
    );
  });
});

describe('github workflow skip seam', () => {
  const EmptySeam = JSON.stringify({ repository: {}, rulesets: [] });
  const Canonical = JSON.stringify({
    repository: { allow_auto_merge: true },
    rulesets: [{ name: 'Protect main', target: 'branch' }],
  });

  it('skips the duplicated live check only for the canonical workflow value', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', Canonical);
    write(consumer, '.github/settings.local.json', EmptySeam);
    const result = runExecutable(
      'bun',
      consumer,
      [ENGINE, 'check', '--dir', consumer],
      { STANDARDS_SKIP_GITHUB_CHECK: 'true' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'live settings check skipped because STANDARDS_SKIP_GITHUB_CHECK=true',
    );
  });

  it('applies the workflow skip seam to explicit github checks but not apply', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', Canonical);
    write(consumer, '.github/settings.local.json', EmptySeam);
    const check = runExecutable(
      'bun',
      consumer,
      [ENGINE, 'github', '--check', '--dir', consumer],
      { STANDARDS_SKIP_GITHUB_CHECK: 'true' },
    );
    const apply = runExecutable(
      'bun',
      consumer,
      [ENGINE, 'github', '--apply', '--dir', consumer],
      { STANDARDS_SKIP_GITHUB_CHECK: 'true' },
    );
    expect(check.status).toBe(0);
    expect(check.stdout).toContain(
      'live settings check skipped because STANDARDS_SKIP_GITHUB_CHECK=true',
    );
    expect(apply.status).toBe(1);
    expect(apply.stderr).toContain(
      'cannot determine the GitHub repository from the origin remote',
    );
  });
});

describe('github configuration validation', () => {
  const EmptySeam = JSON.stringify({ repository: {}, rulesets: [] });
  const Canonical = JSON.stringify({
    repository: { allow_auto_merge: true },
    rulesets: [{ name: 'Protect main', target: 'branch' }],
  });

  it('does not skip for a truthy-looking value other than exact true', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', Canonical);
    write(consumer, '.github/settings.local.json', EmptySeam);
    const result = runExecutable(
      'bun',
      consumer,
      [ENGINE, 'github', '--check', '--dir', consumer],
      { STANDARDS_SKIP_GITHUB_CHECK: 'TRUE' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'cannot determine the GitHub repository from the origin remote',
    );
  });

  it('doctor requires the local seam once the declaration is synced', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', Canonical);
    const result = run(consumer, ['doctor', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.github/settings.local.json must exist');
  });

  it('doctor rejects a seam that overrides canonical values', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', Canonical);
    write(
      consumer,
      '.github/settings.local.json',
      JSON.stringify({
        repository: { allow_auto_merge: false },
        rulesets: [{ name: 'Protect main' }],
      }),
    );
    const result = run(consumer, ['doctor', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'repository."allow_auto_merge" would override a canonical value',
    );
    expect(result.stderr).toContain(
      'ruleset "Protect main" collides with a canonical ruleset',
    );
  });

  it('rejects --apply outside the github command and combined with --check', () => {
    const consumer = mkTmp('sync-cons-');
    const outside = run(consumer, ['sync', '--apply', '--dir', consumer]);
    expect(outside.status).toBe(1);
    expect(outside.stderr).toContain(
      '--apply is only valid with the github command',
    );
    const combined = run(consumer, [
      'github',
      '--check',
      '--apply',
      '--dir',
      consumer,
    ]);
    expect(combined.status).toBe(1);
    expect(combined.stderr).toContain(
      'github accepts exactly one of --check or --apply',
    );
  });
});

describe('option validation', () => {
  it('rejects --check outside the github and dependabot commands', () => {
    const consumer = mkTmp('sync-cons-');
    const result = run(consumer, ['sync', '--check', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '--check is only valid with the github and dependabot commands',
    );
  });

  it('rejects --write outside the dependabot command', () => {
    const consumer = mkTmp('sync-cons-');
    const result = run(consumer, ['sync', '--write', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '--write is only valid with the dependabot command',
    );
  });
});

describe('help', () => {
  it('fails with usage when no command is given', () => {
    const consumer = mkTmp('sync-cons-');
    const result = run(consumer, ['--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('a command is required');
    expect(result.stderr).toContain('Usage: standards <command>');
  });

  it('prints usage and exits 0 for help, --help, and -h', () => {
    const consumer = mkTmp('sync-cons-');
    for (const spelling of ['help', '--help', '-h']) {
      const result = run(consumer, [spelling]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Usage: standards <command>');
      expect(result.stdout).toContain('remote Git/GitHub sources only');
    }
  });
});

describe('unknown command', () => {
  it('exits 1 with Unknown command', () => {
    const consumer = mkTmp('sync-cons-');
    const result = run(consumer, ['bogus', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown command');
  });
});

describe('path safety', () => {
  it('rejects managed paths that escape the source repository', () => {
    const up = buildUpstream(['../outside']);
    const consumer = mkTmp('sync-cons-');
    const result = run(consumer, ['init', '--from', up, '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'managed path must be a normalized repository-relative path',
    );
  });
});
