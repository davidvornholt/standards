// Black-box integration tests: drive the sync CLI as a subprocess against
// throwaway temp fixtures and assert its documented status/stdout/stderr.

import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

const ENGINE = join(import.meta.dir, 'cli.ts');
const ACTUAL_UPSTREAM = join(import.meta.dir, '../../..');
const SYNC_WORKFLOW = join(
  ACTUAL_UPSTREAM,
  '.github/workflows/standards-sync.yml',
);
const STD_PATHS: ReadonlyArray<string> = ['sync-standards.json', 'managed'];

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
  ['a wrong ref type', '{ "ref": 1 }', '"ref" must be a non-empty string'],
  [
    'an unsupported field',
    '{ "branch": "stable" }',
    'contains unsupported field(s): branch',
  ],
] as const;

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

const workflowRunScript = (stepName: string): string => {
  const lines = readFileSync(SYNC_WORKFLOW, 'utf8').split('\n');
  const stepIndex = lines.indexOf(`      - name: ${stepName}`);
  if (stepIndex === -1) {
    throw new Error(`Workflow step not found: ${stepName}`);
  }
  const runIndex = lines.indexOf('        run: |', stepIndex);
  if (runIndex === -1) {
    throw new Error(`Workflow run script not found: ${stepName}`);
  }
  const scriptLines: Array<string> = [];
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.length > 0 && !line.startsWith('          ')) {
      break;
    }
    scriptLines.push(line.startsWith('          ') ? line.slice(10) : line);
  }
  return scriptLines.join('\n').trimEnd();
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
    'template/.github/dependabot.yml',
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

afterEach(() => {
  while (tmps.length > 0) {
    const dir = tmps.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('init', () => {
  it('seeds a template-only file, mirrors managed files, writes lock', () => {
    const { consumer, result } = initConsumer(buildUpstream());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('seeded seed.txt');
    expect(result.stdout).toContain('init complete:');
    expect(read(consumer, 'seed.txt')).toBe('seed original\n');
    expect(read(consumer, '.github/dependabot.yml')).toContain(
      'package-ecosystem: bun',
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
  });
});

describe('check', () => {
  it('passes right after init', () => {
    const { consumer } = initConsumer(buildUpstream());
    const check = run(consumer, ['check', '--dir', consumer]);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain('canonical file(s) match upstream');
  });

  it('fails and reports modified when a managed file is edited', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, 'managed/a.txt', 'tampered\n');
    const check = run(consumer, ['check', '--dir', consumer]);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('canonical file(s) drifted from upstream');
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
    expect(doctor.stderr).toContain('.github/dependabot.yml must exist');
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
      '.github/dependabot.yml',
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
    write(consumer, '.github/dependabot.yml', 'version: [\n');

    const doctor = run(consumer, ['doctor', '--dir', consumer]);

    expect(doctor.status).toBe(1);
    expect(doctor.stderr).toContain('must contain valid YAML');
  });

  it('rejects unsupported and incomplete cron schedules', () => {
    const { consumer } = initConsumer(buildUpstream());
    const dependabotPath = '.github/dependabot.yml';
    write(
      consumer,
      dependabotPath,
      read(consumer, dependabotPath)
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
      '.github/dependabot.yml',
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

    const doctor = run(consumer, ['doctor', '--dir', consumer]);

    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain('consumer integration seams are wired');
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

describe('sync policy distribution', () => {
  it('the packed declared consumer version honors the workflow sync pin', () => {
    const packageManifest = JSON.parse(
      readFileSync(join(import.meta.dir, '../package.json'), 'utf8'),
    ) as { version: string };
    const templateManifest = JSON.parse(
      readFileSync(join(ACTUAL_UPSTREAM, 'template/package.json'), 'utf8'),
    ) as {
      devDependencies: Record<string, string>;
    };
    expect(templateManifest.devDependencies['@davidvornholt/standards']).toBe(
      packageManifest.version,
    );

    const packed = mkTmp('standards-pack-');
    const pack = runExecutable('bun', join(import.meta.dir, '..'), [
      'pm',
      'pack',
      '--destination',
      packed,
      '--quiet',
    ]);
    expect(pack.status).toBe(0);
    const tarball = pack.stdout.trim();
    const consumer = mkTmp('sync-cons-');
    write(
      consumer,
      'package.json',
      JSON.stringify({
        private: true,
        scripts: { standards: 'standards' },
        devDependencies: {
          '@davidvornholt/standards': `file:${tarball}`,
        },
      }),
    );
    expect(
      runExecutable('bun', consumer, ['install', '--ignore-scripts']).status,
    ).toBe(0);

    const { up, url } = buildGitUpstream();
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
    write(consumer, 'sync-standards.local.json', '{ "ref": "v1" }\n');

    const result = runExecutable('bun', consumer, [
      'standards',
      'sync',
      '--from',
      url,
      '--dir',
      consumer,
    ]);

    expect(result.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
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
    ['an unsupported field', '{ "branch": "stable" }'],
  ])('fails closed for %s', (_label, policy) => {
    const { result, output } = runPolicyPreflight(policy);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'sync-standards.local.json must be an object',
    );
    expect(output).toBe('');
  });

  const runVersionGuard = (version: string): RunResult => {
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
        workflowRunScript('Require policy-aware standards CLI'),
      ],
      { MINIMUM_STANDARDS_VERSION: '0.7.0' },
    );
  };

  it.each([
    '0.6.0',
    '0.7.0-beta.1',
  ])('rejects installed CLI version %s', (version) => {
    const result = runVersionGuard(version);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('::error::');
  });

  it.each(['0.7.0', '0.8.0'])('accepts installed CLI version %s', (version) => {
    expect(runVersionGuard(version).status).toBe(0);
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

  it('rejects --check outside the github command', () => {
    const consumer = mkTmp('sync-cons-');
    const result = run(consumer, ['sync', '--check', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '--check is only valid with the github command',
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
