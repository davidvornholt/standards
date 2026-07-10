// Black-box integration tests: drive the sync CLI as a subprocess against
// throwaway temp fixtures and assert its documented status/stdout/stderr.

import { afterEach, describe, expect, test } from 'bun:test';
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

const ENGINE = join(import.meta.dir, 'sync-standards.ts');
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
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? ''),
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

afterEach(() => {
  while (tmps.length > 0) {
    const dir = tmps.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('init', () => {
  test('seeds a template-only file, mirrors managed files, writes lock', () => {
    const { consumer, result } = initConsumer(buildUpstream());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('seeded seed.txt');
    expect(result.stdout).toContain('init complete:');
    expect(read(consumer, 'seed.txt')).toBe('seed original\n');
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(readLock(consumer).files['managed/a.txt']).toBeDefined();
  });

  test('never clobbers a pre-existing seed destination', () => {
    const up = buildUpstream();
    const consumer = mkTmp('sync-cons-');
    write(consumer, 'seed.txt', 'mine\n');
    const result = run(consumer, ['init', '--from', up, '--dir', consumer]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('kept seed.txt (already present)');
    expect(read(consumer, 'seed.txt')).toBe('mine\n');
  });

  test('refuses to re-initialize when a lock already exists', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    write(consumer, 'managed/a.txt', 'local edit\n');
    const again = run(consumer, ['init', '--from', up, '--dir', consumer]);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('already initialized');
    expect(read(consumer, 'managed/a.txt')).toBe('local edit\n');
  });

  test('errors when a managed path overlaps a seed target', () => {
    const { consumer, result } = initConsumer(buildUpstream(['seed.txt']));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('overlaps seed path');
    expect(existsSync(join(consumer, 'sync-standards.lock'))).toBe(false);
  });
});

describe('--check', () => {
  test('passes right after init', () => {
    const { consumer } = initConsumer(buildUpstream());
    const check = run(consumer, ['--check', '--dir', consumer]);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain('canonical file(s) match upstream');
  });

  test('fails and reports modified when a managed file is edited', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, 'managed/a.txt', 'tampered\n');
    const check = run(consumer, ['--check', '--dir', consumer]);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('canonical file(s) drifted from upstream');
    expect(check.stderr).toContain('modified: managed/a.txt');
  });

  test('fails and reports missing when a managed file is deleted', () => {
    const { consumer } = initConsumer(buildUpstream());
    rmSync(join(consumer, 'managed/a.txt'));
    const check = run(consumer, ['--check', '--dir', consumer]);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('missing:  managed/a.txt');
  });
});

describe('sync', () => {
  test('uses new managed paths from the upstream manifest immediately', () => {
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

  test('deletes a consumer file removed from upstream and prunes the lock', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    rmSync(join(up, 'managed/b.txt'));
    const result = sync(up, consumer);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('deleted managed/b.txt (removed upstream)');
    expect(existsSync(join(consumer, 'managed/b.txt'))).toBe(false);
    expect(readLock(consumer).files['managed/b.txt']).toBeUndefined();
  });

  test('updates a changed upstream file and check passes afterward', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    write(up, 'managed/a.txt', 'alpha v2\n');
    const result = sync(up, consumer);
    expect(result.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha v2\n');
    expect(run(consumer, ['--check', '--dir', consumer]).status).toBe(0);
  });

  test('dry-run writes nothing, then a real sync applies the change', () => {
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

  test('dry-run reports no changes when already in sync', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    const dry = sync(up, consumer, ['--dry-run']);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('dry run: already in sync; no changes');
  });
});

describe('unknown command', () => {
  test('exits 1 with Unknown command', () => {
    const consumer = mkTmp('sync-cons-');
    const result = run(consumer, ['bogus', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown command');
  });
});
