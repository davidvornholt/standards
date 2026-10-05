// The adoption guard: init and sync refuse a managed destination occupied by a
// directory holding paths the lock does not record, before they write anything.
// Whether the lock records the destination itself decides nothing — only what is
// inside it does.

import { afterEach, describe, expect, it } from 'bun:test';
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { cleanupTmpDirs, mkTmp, write } from './cli-test-support';
import {
  buildUpstream,
  engineFor,
  LINK,
  SKILL,
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
      `${LINK} should be a symlink to the canonical .agents/skills, but it is a directory holding 1 path(s) this repository does not manage (${OWN_SKILL})`,
    );
    expect(result.stderr).toContain(`rm -rf ${LINK} && bun standards init`);
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
      'directory holding 2 path(s) this repository does not manage',
    );
    expect(existsSync(join(consumer, OWN_SKILL))).toBe(true);
    expect(existsSync(join(consumer, `${LINK}/notes.md`))).toBe(true);
  });

  it('names the fix when a copy tool flattened the link into a directory', () => {
    // `zip` without `-y` and copies that follow links materialize the link as a
    // directory of byte-identical copies. The lock records only the link, so the
    // copies are refused like any other unowned work, with the exact way back.
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    rmSync(join(consumer, LINK));
    cpSync(join(consumer, '.agents/skills'), join(consumer, LINK), {
      recursive: true,
    });

    const result = run(consumer, ['sync', '--from', up, '--dir', consumer]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `${LINK} should be a symlink to the canonical .agents/skills, but it is a directory holding 1 path(s) this repository does not manage (${LINK}/probe/SKILL.md); copy and zip tools that follow links can cause this. First move any of your own files out of ${LINK}, then run \`rm -rf ${LINK} && bun standards sync\``,
    );
    expect(readFileSync(join(consumer, `${LINK}/probe/SKILL.md`), 'utf8')).toBe(
      readFileSync(join(consumer, SKILL), 'utf8'),
    );
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
      'directory holding 1 path(s) this repository does not manage',
    );
    expect(readFileSync(join(consumer, OWN_SKILL), 'utf8')).toBe(
      'name: mine\n',
    );
  });
});
