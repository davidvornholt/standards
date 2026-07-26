// init and sync refuse a canonical link whose target leaves the repository
// before they write anything. The refusal is a precondition, so the consumer
// must be exactly as it was. The other precondition — a managed destination
// occupied by a directory of consumer work — is pinned in
// `managed-files-adoption.test.ts`.

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, lstatSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { cleanupTmpDirs, mkTmp, write } from './cli-test-support';
import {
  buildUpstream,
  engineFor,
  LINK,
} from './managed-files-symlink-test-support';

const { initConsumer, run } = engineFor({ ...process.env });

const untouched = (consumer: string): boolean =>
  !(
    existsSync(join(consumer, 'sync-standards.lock')) ||
    existsSync(join(consumer, 'sync-standards.json')) ||
    existsSync(join(consumer, 'seed.txt')) ||
    existsSync(join(consumer, '.github/dependabot.base.yml'))
  );

afterEach(cleanupTmpDirs);

describe('escaping canonical symlink targets', () => {
  it('refuses a target that escapes the repository before writing anything', () => {
    const { consumer, result } = initConsumer(
      buildUpstream({ target: '../../../etc' }),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `canonical symlink ${LINK} must point inside the repository`,
    );
    expect(lstatSync(join(consumer, LINK), { throwIfNoEntry: false })).toBe(
      undefined,
    );
    // The guarantee the canonical skill documents: nothing at all was mirrored.
    expect(untouched(consumer)).toBe(true);
    expect(readdirSync(consumer)).toEqual([]);
  });

  it('refuses a drive-qualified target, which POSIX would treat as relative', () => {
    const { consumer, result } = initConsumer(
      buildUpstream({ target: 'C:/Windows/System32' }),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('C:/Windows/System32');
    expect(untouched(consumer)).toBe(true);
  });

  it('reports every offending link in one run', () => {
    const up = buildUpstream({ target: '../../../etc' });
    symlinkSync('../../../../etc/passwd', join(up, '.agents/skills/escape'));

    const { result } = initConsumer(up);

    expect(result.stderr).toContain(`canonical symlink ${LINK}`);
    expect(result.stderr).toContain('canonical symlink .agents/skills/escape');
  });

  it('refuses an escaping link in the seed directory before writing anything', () => {
    const up = buildUpstream();
    symlinkSync('../../../etc/passwd', join(up, 'template/escape'));

    const { consumer, result } = initConsumer(up);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('canonical symlink escape');
    expect(untouched(consumer)).toBe(true);
  });

  it('keeps a broken link at a seed destination instead of seeding through it', () => {
    const consumer = mkTmp('symlink-cons-');
    const outside = mkTmp('outside-');
    symlinkSync(join(outside, 'planted.txt'), join(consumer, 'seed.txt'));

    const result = run(consumer, [
      'init',
      '--from',
      buildUpstream(),
      '--dir',
      consumer,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('kept seed.txt (already present)');
    // `existsSync` reports a broken link as absent, and writing through one
    // creates the file it names — here, outside the repository entirely.
    expect(existsSync(join(outside, 'planted.txt'))).toBe(false);
  });

  it('seeds a link whose target stays inside the repository', () => {
    const up = buildUpstream();
    write(up, 'template/docs/note.md', 'note\n');
    symlinkSync('docs/note.md', join(up, 'template/note-link.md'));

    const { consumer, result } = initConsumer(up);

    expect(result.status).toBe(0);
    expect(lstatSync(join(consumer, 'note-link.md')).isSymbolicLink()).toBe(
      true,
    );
  });
});
