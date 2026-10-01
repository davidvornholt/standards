import { afterEach, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { cleanupTmpDirs, mkTmp, runProcess, write } from './cli-test-support';
import {
  namedStep,
  parsedWorkflow,
} from './standards-sync-broker-workflow-contract';
import {
  SYNC_BRANCH as BRANCH,
  fakeGitHub,
  RECONCILE_STEP,
  runSyncStep,
} from './standards-sync-workflow-test-support';

const MODE = 0o755;
const git = (cwd: string, ...args: Array<string>): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const env = (
  values: Record<string, string>,
): Record<string, string | undefined> => ({ ...process.env, ...values });
const shell = (cwd: string, name: string, values: Record<string, string>) =>
  runSyncStep(cwd, name, env(values));
afterEach(cleanupTmpDirs);

it.each([false, true])(
  'reuses the branch and PR after another run (first PR creation failed: %s)',
  (failFirst) => {
    const root = mkTmp('sync-reuse-');
    const remote = join(root, 'remote.git');
    git(root, 'init', '--bare', '--initial-branch=main', remote);
    const first = join(root, 'first');
    git(root, 'clone', remote, first);
    git(first, 'config', 'commit.gpgsign', 'false');
    git(
      first,
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'base',
    );
    git(first, 'push', 'origin', 'main');
    const values: Record<string, string> = {
      ...fakeGitHub(root, process.env.PATH ?? ''),
      ...Object.fromEntries([
        ['SYNC_BASE_REF', 'main'],
        ['SYNC_READ_TOKEN', 'read-fixture'],
        ['BRANCH_WRITER_TOKEN', 'write-fixture'],
        ['MIRROR_CHANGED', 'true'],
      ]),
    };
    for (const [index, cwd] of [first, join(root, 'second')].entries()) {
      if (index > 0) {
        git(root, 'clone', remote, cwd);
        git(cwd, 'config', 'commit.gpgsign', 'false');
      }
      const output = join(root, `outputs-${index}`);
      const runEnv = { ...values, [['GITHUB', 'OUTPUT'].join('_')]: output };
      expect(shell(cwd, 'Prepare reusable sync branch', runEnv).status).toBe(0);
      const previous = readFileSync(output, 'utf8')
        .trim()
        .slice('previous='.length);
      write(cwd, 'canonical.txt', `revision ${index}\n`);
      expect(
        shell(cwd, 'Commit and push mirror changes', {
          ...runEnv,
          [['EXPECTED', 'SYNC', 'HEAD'].join('_')]: previous,
        }).status,
      ).toBe(0);
      const fail = failFirst && index === 0;
      expect(
        shell(cwd, RECONCILE_STEP, {
          ...runEnv,
          [['FAIL', 'CREATE'].join('_')]: String(fail),
        }).status,
      ).toBe(fail ? 1 : 0);
      if (index === 0) {
        write(cwd, 'seam.txt', 'maintainer configuration\n');
        git(cwd, 'add', 'seam.txt');
        git(cwd, 'commit', '-m', 'preserve reviewed seam cleanup');
        git(cwd, 'push', 'origin', BRANCH);
        git(cwd, 'switch', 'main');
        write(cwd, 'base-update.txt', 'new main\n');
        git(cwd, 'add', 'base-update.txt');
        git(cwd, 'commit', '-m', 'advance main');
        git(cwd, 'push', 'origin', 'main');
      }
    }
    expect(
      git(
        root,
        '--git-dir',
        remote,
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/heads',
      ),
    ).toBe(`main\n${BRANCH}`);
    expect(git(root, '--git-dir', remote, 'show', `${BRANCH}:seam.txt`)).toBe(
      'maintainer configuration',
    );
    expect(
      git(root, '--git-dir', remote, 'show', `${BRANCH}:base-update.txt`),
    ).toBe('new main');
    expect(JSON.parse(readFileSync(join(root, 'pr-state'), 'utf8'))).toEqual([
      { number: 7, headRefName: BRANCH, isCrossRepository: false },
    ]);
    expect(readFileSync(join(root, 'pr-creations'), 'utf8')).toBe('created\n');
    expect(existsSync(join(root, 'pr-closures'))).toBe(false);
  },
);

const seedSyncRuntime = (cwd: string, isolated: boolean): string => {
  const cliPackage = isolated
    ? 'node_modules/.bun/standards@0.27.0/node_modules/@davidvornholt/standards'
    : 'node_modules/@davidvornholt/standards';
  const dependency = isolated
    ? 'node_modules/.bun/yaml@2.8.0/node_modules/yaml'
    : 'node_modules/yaml';
  write(
    cwd,
    `${dependency}/package.json`,
    '{"name":"yaml","type":"module","exports":"./index.js"}',
  );
  write(
    cwd,
    `${dependency}/index.js`,
    "export const value = 'trusted sync';\n",
  );
  if (isolated) {
    mkdirSync(join(cwd, 'node_modules/@davidvornholt'), { recursive: true });
    mkdirSync(join(cwd, 'node_modules/.bun/standards@0.27.0/node_modules'), {
      recursive: true,
    });
    symlinkSync(
      '../.bun/standards@0.27.0/node_modules/@davidvornholt/standards',
      join(cwd, 'node_modules/@davidvornholt/standards'),
    );
    symlinkSync(
      '../../yaml@2.8.0/node_modules/yaml',
      join(cwd, 'node_modules/.bun/standards@0.27.0/node_modules/yaml'),
    );
  }
  write(
    cwd,
    `${cliPackage}/src/cli.ts`,
    `import { writeFileSync } from 'node:fs';
import { value } from 'yaml';
writeFileSync(process.argv[process.argv.indexOf('--dir') + 1] + '/canonical.txt', value);\n`,
  );
  return dependency;
};

it.each([false, true])(
  'does not execute branch package scripts, Bun preloads, or Git hooks with writer credentials (isolated linker: %s)',
  (isolated) => {
    const root = mkTmp('sync-runtime-');
    const cwd = join(root, 'consumer');
    const remote = join(root, 'remote.git');
    git(root, 'init', '--bare', '--initial-branch=main', remote);
    git(root, 'clone', remote, cwd);
    git(cwd, 'config', 'user.name', 'fixture');
    git(cwd, 'config', 'user.email', 'fixture@example.invalid');
    git(cwd, 'config', 'commit.gpgsign', 'false');
    write(cwd, '.gitignore', 'node_modules/\n');
    write(cwd, 'sync-standards.json', '{"upstream":"owner/trusted"}\n');
    const dependency = seedSyncRuntime(cwd, isolated);
    git(cwd, 'add', '.gitignore');
    git(cwd, 'commit', '-m', 'base');
    git(cwd, 'push', 'origin', 'main');
    const output = join(root, 'output');
    const values = Object.fromEntries([
      ['RUNNER_TEMP', root],
      ['GITHUB_ENV', output],
      ['GITHUB_OUTPUT', join(root, 'branch-output')],
      ['GITHUB_WORKSPACE', cwd],
      ['SYNC_BASE_REF', 'main'],
      ['SYNC_READ_TOKEN', 'read-fixture'],
      ['SYNC_POLICY_REF', ''],
    ]);
    expect(shell(cwd, 'Preserve trusted sync runtime', values).status).toBe(0);
    const runtime = readFileSync(output, 'utf8').trim().split('=')[1] ?? '';
    expect(shell(cwd, 'Prepare reusable sync branch', values).status).toBe(0);
    // Changing the checkout after preservation must not change the trusted copy.
    write(
      cwd,
      `${dependency}/index.js`,
      "export const value = 'branch dependency';\n",
    );
    write(
      cwd,
      'package.json',
      '{"scripts":{"standards":"touch package-script-ran"}}\n',
    );
    write(cwd, 'bunfig.toml', 'preload = ["./evil.ts"]\n');
    write(
      cwd,
      'evil.ts',
      "import { writeFileSync } from 'node:fs'; writeFileSync('preload-ran', 'unsafe');\n",
    );
    const syncEnv = {
      ...values,
      [['STANDARDS', 'SYNC', 'RUNTIME'].join('_')]: runtime,
    };
    expect(
      shell(cwd, 'Sync canonical files from upstream', syncEnv).status,
    ).toBe(0);
    expect(readFileSync(join(cwd, 'canonical.txt'), 'utf8')).toBe(
      'trusted sync',
    );
    write(cwd, 'sync-standards.json', '{"upstream":"owner/different"}\n');
    expect(
      shell(cwd, 'Sync canonical files from upstream', syncEnv).status,
    ).toBe(1);
    write(cwd, 'sync-standards.json', '{"upstream":"owner/trusted"}\n');
    write(cwd, 'sync-standards.local.json', '{"ref":"different"}\n');
    expect(
      shell(cwd, 'Sync canonical files from upstream', syncEnv).status,
    ).toBe(1);
    write(cwd, 'sync-standards.local.json', '{}\n');
    expect(existsSync(join(cwd, 'package-script-ran'))).toBe(false);
    expect(existsSync(join(cwd, 'preload-ran'))).toBe(false);
    write(
      cwd,
      '.git/hooks/pre-commit',
      '#!/bin/sh\necho "$BRANCH_WRITER_TOKEN" > hook-leak\n',
    );
    chmodSync(join(cwd, '.git/hooks/pre-commit'), MODE);
    write(
      cwd,
      '.git/hooks/pre-push',
      '#!/bin/sh\necho "$BRANCH_WRITER_TOKEN" > push-leak\n',
    );
    chmodSync(join(cwd, '.git/hooks/pre-push'), MODE);
    expect(
      shell(cwd, 'Commit and push mirror changes', {
        ...syncEnv,
        [['BRANCH', 'WRITER', 'TOKEN'].join('_')]: 'synthetic-write-token',
        [['EXPECTED', 'SYNC', 'HEAD'].join('_')]: '',
      }).status,
    ).toBe(0);
    expect(existsSync(join(cwd, 'hook-leak'))).toBe(false);
    expect(existsSync(join(cwd, 'push-leak'))).toBe(false);
  },
);

it('refreshes the lockfile with the trusted Bun config instead of the branch config', () => {
  const root = mkTmp('sync-lockfile-');
  const cwd = join(root, 'consumer');
  const runtime = join(root, 'runtime');
  write(cwd, 'package.json', '{"name":"fixture"}\n');
  // Bun refuses to start with a malformed bunfig.toml, so success shows that
  // the step never loaded the branch's configuration.
  write(cwd, 'bunfig.toml', 'not [valid toml\n');
  write(runtime, 'bunfig.toml', '');
  const script = namedStep(parsedWorkflow, 'Refresh consumer lockfile').run;
  expect(
    runProcess(
      'bash',
      cwd,
      ['-euo', 'pipefail', '-c', script ?? 'false'],
      env({ [['STANDARDS', 'SYNC', 'RUNTIME'].join('_')]: runtime }),
    ).status,
  ).toBe(0);
});
