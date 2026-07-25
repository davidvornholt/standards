// The prune pass: what sync does with a locked path that vanished upstream. It
// must remove what it owns, notice a broken link where `existsSync` would not,
// and never reach through a symlink or recursively delete consumer work.

import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { cleanupTmpDirs, write } from './cli-test-support';
import {
  buildUpstream,
  engineFor,
  LINK,
  lockedPaths,
  readLock,
  SKILL,
  TARGET,
  writeLockFiles,
} from './managed-files-symlink-test-support';

const { initConsumer, run } = engineFor({ ...process.env });

const LEGACY = 'docs/legacy.md';
const DUPLICATE = `${LINK}/probe/SKILL.md`;

const sha256 = (content: string): string =>
  createHash('sha256').update(Buffer.from(content)).digest('hex');

afterEach(cleanupTmpDirs);

describe('pruning locked paths that vanished upstream', () => {
  it('deletes a managed file upstream dropped', () => {
    const { consumer } = initConsumer(buildUpstream({ extra: [LEGACY] }));

    const result = run(consumer, [
      'sync',
      '--from',
      buildUpstream(),
      '--dir',
      consumer,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`deleted ${LEGACY} (removed upstream)`);
    expect(existsSync(join(consumer, LEGACY))).toBe(false);
    expect(lockedPaths(consumer)).not.toContain(LEGACY);
  });

  it('deletes a broken link `existsSync` would report as absent', () => {
    const { consumer } = initConsumer(buildUpstream({ extra: [LEGACY] }));
    rmSync(join(consumer, LEGACY));
    symlinkSync('vanished.md', join(consumer, LEGACY));

    const result = run(consumer, [
      'sync',
      '--from',
      buildUpstream(),
      '--dir',
      consumer,
    ]);

    expect(result.stdout).toContain(`deleted ${LEGACY} (removed upstream)`);
    expect(lstatSync(join(consumer, LEGACY), { throwIfNoEntry: false })).toBe(
      undefined,
    );
  });

  it('leaves a directory a consumer built at a dropped path, and says so', () => {
    const { consumer } = initConsumer(buildUpstream({ extra: [LEGACY] }));
    rmSync(join(consumer, LEGACY));
    write(consumer, `${LEGACY}/team/notes.md`, 'team notes\n');
    const dropped = buildUpstream();

    const dryRun = run(consumer, [
      'sync',
      '--from',
      dropped,
      '--dir',
      consumer,
      '--dry-run',
    ]);
    const result = run(consumer, [
      'sync',
      '--from',
      dropped,
      '--dir',
      consumer,
    ]);

    expect(result.status).toBe(0);
    expect(dryRun.stdout).toContain(`left in place ${LEGACY}`);
    expect(result.stdout).toContain(`left in place ${LEGACY}`);
    expect(
      readFileSync(join(consumer, `${LEGACY}/team/notes.md`), 'utf8'),
    ).toBe('team notes\n');
  });

  it('never deletes through a symlink an older lock recorded past', () => {
    // What the published CLI produced: it followed the canonical link, so its
    // lock names the duplicated tree as well as the real one.
    const up = buildUpstream();
    const { consumer } = initConsumer(buildUpstream({ linked: false }));
    write(consumer, DUPLICATE, '---\nname: probe\n---\n');
    writeLockFiles(consumer, {
      ...readLock(consumer),
      [DUPLICATE]: sha256('---\nname: probe\n---\n'),
    });

    const result = run(consumer, ['sync', '--from', up, '--dir', consumer]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`left in place ${DUPLICATE}`);
    expect(result.stdout).toContain(`symlink ${LINK}`);
    // The one real copy, inside the link's target, is untouched.
    expect(readFileSync(join(consumer, SKILL), 'utf8')).toContain(
      'name: probe',
    );
    expect(readlinkSync(join(consumer, LINK))).toBe(TARGET);
    expect(lockedPaths(consumer)).not.toContain(DUPLICATE);
    // The lock the same run writes must describe a repository that passes.
    expect(run(consumer, ['check', '--dir', consumer]).stderr).not.toContain(
      'drifted',
    );
  });
});
