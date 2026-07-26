// The adoption guard: init and sync refuse a managed destination occupied by a
// directory holding paths the lock does not record, before they write anything.
// Whether the lock records the destination itself decides nothing — only what is
// inside it does.

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { cleanupTmpDirs, mkTmp, write } from './cli-test-support';
import {
  buildUpstream,
  engineFor,
  LINK,
} from './managed-files-symlink-test-support';

const { initConsumer, run } = engineFor({ ...process.env });

const OWN_SKILL = `${LINK}/my-local-skill/SKILL.md`;

// Nothing this engine writes may exist after a refusal.
const untouched = (consumer: string): boolean =>
  !(
    existsSync(join(consumer, 'sync-standards.lock')) ||
    existsSync(join(consumer, 'sync-standards.json')) ||
    existsSync(join(consumer, 'seed.txt')) ||
    existsSync(join(consumer, '.github/dependabot.base.yml'))
  );

afterEach(cleanupTmpDirs);

describe('managed destinations the engine never managed', () => {
  it('refuses to init over a consumer-owned directory instead of deleting it', () => {
    const consumer = mkTmp('symlink-cons-');
    write(consumer, OWN_SKILL, 'name: mine\n');

    const result = run(consumer, [
      'init',
      '--from',
      buildUpstream(),
      '--dir',
      consumer,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `${LINK} is a directory holding 1 path(s) this repository does not manage`,
    );
    expect(result.stderr).toContain(OWN_SKILL);
    expect(existsSync(join(consumer, OWN_SKILL))).toBe(true);
    expect(untouched(consumer)).toBe(true);
  });

  it('refuses a sync that would delete a directory a consumer built there', () => {
    // The realistic upgrade: adopted before the link existed, own skills added,
    // then upstream starts managing the path the skills sit at.
    const { consumer } = initConsumer(
      buildUpstream({ claudeSkills: 'absent' }),
    );
    write(consumer, OWN_SKILL, 'name: mine\n');
    write(consumer, `${LINK}/notes.md`, 'notes\n');
    const linked = buildUpstream();

    const dryRun = run(consumer, [
      'sync',
      '--from',
      linked,
      '--dir',
      consumer,
      '--dry-run',
    ]);
    const result = run(consumer, ['sync', '--from', linked, '--dir', consumer]);

    expect(dryRun.status).not.toBe(0);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `${LINK} is a directory holding 2 path(s) this repository does not manage`,
    );
    expect(existsSync(join(consumer, OWN_SKILL))).toBe(true);
    expect(existsSync(join(consumer, `${LINK}/notes.md`))).toBe(true);
  });

  it('refuses when the offending directory sits at a path the lock records', () => {
    // The state of every consumer that has already adopted the link: the lock
    // records `.claude/skills` as a symlink. A merge from a pre-adoption branch,
    // a restore from backup, or any tool that recreates the path can put a real
    // directory of consumer work back there. Whether the lock knows the
    // destination says nothing about who owns what is inside it.
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    rmSync(join(consumer, LINK));
    write(consumer, OWN_SKILL, 'name: mine\n');

    const result = run(consumer, ['sync', '--from', up, '--dir', consumer]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `${LINK} is a directory holding 1 path(s) this repository does not manage`,
    );
    expect(readFileSync(join(consumer, OWN_SKILL), 'utf8')).toBe(
      'name: mine\n',
    );
  });

  it('still adopts the link over a directory holding only locked paths', () => {
    // The migration the refusal must not block: every path under the directory
    // is one this engine wrote and the lock records, so replacing the whole
    // directory with the link destroys nothing.
    const { consumer } = initConsumer(
      buildUpstream({ claudeSkills: 'directory' }),
    );

    const result = run(consumer, [
      'sync',
      '--from',
      buildUpstream(),
      '--dir',
      consumer,
    ]);

    expect(result.status).toBe(0);
    expect(lstatSync(join(consumer, LINK)).isSymbolicLink()).toBe(true);
  });
});
