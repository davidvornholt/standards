// Black-box sync raising a consumer's Bun pins to the Bun of the standards
// source it syncs from.

import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { raiseSyncedBunPins } from './bun-command';
import {
  cleanupTmpDirs,
  mkTmp,
  type RunResult,
  runProcess,
  write,
  writeSyncManifest,
} from './cli-test-support';

afterEach(cleanupTmpDirs);

const ENGINE = join(import.meta.dir, 'cli.ts');
const MANAGED = 'managed/setup.yml';

const run = (cwd: string, args: ReadonlyArray<string>): RunResult =>
  runProcess('bun', cwd, [ENGINE, ...args], process.env);
const read = (root: string, rel: string): string =>
  readFileSync(join(root, rel), 'utf8');

const upstream = (): string => {
  const up = mkTmp('bun-sync-up-');
  writeSyncManifest(up, up, [MANAGED], ['sync-standards.json']);
  write(up, 'package.json', '{ "packageManager": "bun@1.4.5" }\n');
  write(up, MANAGED, 'bun-version: 1.4.0\n');
  write(up, 'template/package.json', '{}\n');
  return up;
};

const CONSUMER_FILES = [
  ['package.json', '{ "packageManager": "bun@1.4.3" }\n'],
  ['apps/api/Dockerfile', 'ARG BUN_VERSION=1.4.3\nFROM base\n'],
  ['tools/package.json', '{ "packageManager": "bun@1.5.0" }\n'],
] as const;

const consumer = (): string => {
  const dir = mkTmp('bun-sync-cons-');
  execFileSync('git', ['init', '--quiet', dir]);
  for (const [path, content] of CONSUMER_FILES) {
    write(dir, path, content);
  }
  execFileSync('git', ['add', '--all'], { cwd: dir });
  return dir;
};

describe('sync', () => {
  it("raises the consumer's lower Bun pins to the source's Bun", () => {
    const up = upstream();
    const dir = consumer();

    const result = run(dir, ['sync', '--from', up, '--dir', dir]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'raised Bun 1.4.3 to 1.4.5 in apps/api/Dockerfile',
    );
    expect(read(dir, 'package.json')).toBe(
      '{ "packageManager": "bun@1.4.5" }\n',
    );
    expect(read(dir, 'apps/api/Dockerfile')).toBe(
      'ARG BUN_VERSION=1.4.5\nFROM base\n',
    );
    // A newer pin stays, and a managed file keeps the source's content.
    expect(read(dir, 'tools/package.json')).toBe(
      '{ "packageManager": "bun@1.5.0" }\n',
    );
    expect(read(dir, MANAGED)).toBe('bun-version: 1.4.0\n');
  });

  it('reports the raise on a dry run without writing it', () => {
    const up = upstream();
    const dir = consumer();

    const result = run(dir, ['sync', '--from', up, '--dir', dir, '--dry-run']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'would raise Bun 1.4.3 to 1.4.5 in package.json',
    );
    for (const [path, content] of CONSUMER_FILES) {
      expect(read(dir, path)).toBe(content);
    }
  });

  it('raises every other pin when Docker Hub fails', async () => {
    const up = upstream();
    const dir = consumer();
    write(dir, 'Dockerfile', 'FROM oven/bun:1.4.3\n');
    execFileSync('git', ['add', '--all'], { cwd: dir });

    await raiseSyncedBunPins({
      consumer: dir,
      sourceDir: up,
      managed: [],
      dryRun: false,
      resolveDigest: () => Promise.reject(new Error('registry down')),
    });

    expect(read(dir, 'Dockerfile')).toBe('FROM oven/bun:1.4.3\n');
    expect(read(dir, 'package.json')).toBe(
      '{ "packageManager": "bun@1.4.5" }\n',
    );
  });

  it('fails the sync when a pin cannot be written', async () => {
    // Root ignores file modes, so only an unprivileged run can see the failure.
    if (process.getuid?.() === 0) {
      return;
    }
    const up = upstream();
    const dir = consumer();
    chmodSync(join(dir, 'apps/api/Dockerfile'), 0o444);

    await expect(
      raiseSyncedBunPins({
        consumer: dir,
        sourceDir: up,
        managed: [],
        dryRun: false,
      }),
    ).rejects.toThrow('EACCES');
  });
});
