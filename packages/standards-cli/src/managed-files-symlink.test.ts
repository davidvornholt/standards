// Black-box coverage for symlinks as managed paths: the canonical payload
// carries `.claude/skills -> ../.agents/skills` so Claude Code discovers the
// tool-agnostic skills without a second copy of them in every consumer.

import { afterEach, describe, expect, it } from 'bun:test';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { cleanupTmpDirs, mkTmp, write } from './cli-test-support';
import {
  buildUpstream,
  engineFor,
  LINK,
  lockedPaths,
  SKILL,
  TARGET,
} from './managed-files-symlink-test-support';

const { initConsumer, run } = engineFor({ ...process.env });

afterEach(cleanupTmpDirs);

describe('symlinks as managed paths', () => {
  it('mirrors a managed symlink as a link instead of copying its target tree', () => {
    const { consumer, result } = initConsumer(buildUpstream());

    expect(result.status).toBe(0);
    const link = join(consumer, LINK);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(TARGET);
    // Discovery resolves through the link to the one real copy of the skill.
    expect(readFileSync(join(link, 'probe/SKILL.md'), 'utf8')).toContain(
      'name: probe',
    );
  });

  it('locks the link as a single entry rather than the files beneath it', () => {
    const { consumer } = initConsumer(buildUpstream());

    const locked = lockedPaths(consumer);

    expect(locked).toContain(LINK);
    expect(locked).toContain(SKILL);
    expect(locked.filter((rel) => rel.startsWith(`${LINK}/`))).toEqual([]);
  });

  it('reports drift when a consumer retargets the link', () => {
    const { consumer } = initConsumer(buildUpstream());
    rmSync(join(consumer, LINK));
    symlinkSync('../elsewhere', join(consumer, LINK));

    const check = run(consumer, ['check', '--dir', consumer]);

    expect(check.status).not.toBe(0);
    expect(check.stderr).toContain(`modified: ${LINK}`);
  });

  it('reports drift when a consumer replaces the link with a real directory', () => {
    const { consumer } = initConsumer(buildUpstream());
    rmSync(join(consumer, LINK));
    mkdirSync(join(consumer, LINK), { recursive: true });

    const check = run(consumer, ['check', '--dir', consumer]);

    expect(check.status).not.toBe(0);
    expect(check.stderr).toContain(`modified: ${LINK}`);
  });

  it('restores a link a consumer replaced with a real directory', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    rmSync(join(consumer, LINK));
    write(consumer, `${LINK}/stale.md`, 'local copy\n');

    const result = run(consumer, ['sync', '--from', up, '--dir', consumer]);

    expect(result.status).toBe(0);
    expect(lstatSync(join(consumer, LINK)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(consumer, LINK))).toBe(TARGET);
  });

  it('replaces a link at a managed file instead of writing through it', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    const outside = mkTmp('outside-');
    write(outside, 'secret.txt', 'untouched\n');
    rmSync(join(consumer, SKILL));
    symlinkSync(join(outside, 'secret.txt'), join(consumer, SKILL));

    const result = run(consumer, ['sync', '--from', up, '--dir', consumer]);

    expect(result.status).toBe(0);
    expect(lstatSync(join(consumer, SKILL)).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(consumer, SKILL), 'utf8')).toContain(
      'name: probe',
    );
    // Canonical content must never travel through a link to an outside file.
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe(
      'untouched\n',
    );
  });

  it('keeps a consumer skill that lives beside the managed ones', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    write(consumer, '.agents/skills/mine/SKILL.md', 'name: mine\n');

    const result = run(consumer, ['sync', '--from', up, '--dir', consumer]);

    expect(result.status).toBe(0);
    // The documented seam: an unmanaged sibling under a managed directory is
    // never locked, so it survives sync and surfaces through the link.
    expect(
      readFileSync(join(consumer, LINK, 'mine/SKILL.md'), 'utf8'),
    ).toContain('name: mine');
    expect(lockedPaths(consumer)).not.toContain('.agents/skills/mine/SKILL.md');
  });
});
