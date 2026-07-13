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

const ENGINE = join(import.meta.dir, 'cli.ts');
const STD_PATHS: ReadonlyArray<string> = ['sync-standards.json', 'managed'];

type RunResult = { stdout: string; stderr: string; status: number };
type Lock = { upstream: string; sha: string; files: Record<string, string> };

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

const run = (cwd: string, args: ReadonlyArray<string>): RunResult => {
  try {
    const stdout = execFileSync('bun', [ENGINE, ...args], {
      cwd,
      encoding: 'utf8',
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
      scripts: {
        check: 'standards check',
        'check:fix': 'standards check',
      },
      devDependencies: { '@davidvornholt/standards': '0.1.0' },
    }),
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
