// What the prune pass tells the operator. A report is wrong in three ways worth
// pinning: predicting an outcome the real run does not take, naming a path as
// left in place when the same run already removed it, and summing a run that
// rewrites the lock as "no changes". Every line here is read by someone
// deciding what to do next by hand.

import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
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

const DUPLICATE = `${LINK}/probe/SKILL.md`;
const LEGACY = 'docs/legacy.md';

const sha256 = (content: string): string =>
  createHash('sha256').update(Buffer.from(content)).digest('hex');

// A dry run and the real run it predicts differ only in tense. Reduce both to
// the same voice so a divergence in the outcome itself — or in the reason given
// for it — fails as an inequality rather than hiding behind the wording.
const TENSES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^ {2}(?:would delete|deleted) /u, 'delete '],
  [/^ {2}(?:would leave in place|left in place) /u, 'retain '],
  [/^ {2}(?:would drop|dropped) the stale lock entry /u, 'drop '],
];

const pruneOutcomes = (stdout: string): ReadonlyArray<string> =>
  stdout
    .split('\n')
    .flatMap((line) => {
      const tense = TENSES.find(([pattern]) => pattern.test(line));
      return tense === undefined ? [] : [line.replace(tense[0], tense[1])];
    })
    .sort();

afterEach(cleanupTmpDirs);

describe('predicting the prune pass before performing it', () => {
  it('predicts the link migration exactly as it performs it', () => {
    // The flagship upgrade: a consumer whose lock names the materialized copies
    // an older payload duplicated under `.claude/skills`, syncing against the
    // payload that replaced them with a link.
    const { consumer } = initConsumer(
      buildUpstream({ claudeSkills: 'directory' }),
    );
    expect(lockedPaths(consumer)).toContain(DUPLICATE);
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

    expect(result.status).toBe(0);
    expect(pruneOutcomes(dryRun.stdout)).toEqual(pruneOutcomes(result.stdout));
    expect(pruneOutcomes(result.stdout)).toEqual([
      `drop ${DUPLICATE} (below the symlink ${LINK}; nothing was deleted through it)`,
    ]);
    // Nothing distinct is left in place to act on: the mirror replaced the whole
    // directory with the link, so the duplicate now *is* the one real copy.
    // Telling an operator to delete it would destroy canonical content.
    expect(result.stdout).not.toContain('left in place');
    expect(result.stdout).not.toContain('delete it yourself');
    expect(readlinkSync(join(consumer, LINK))).toBe(TARGET);
    expect(lstatSync(join(consumer, DUPLICATE)).ino).toBe(
      lstatSync(join(consumer, SKILL)).ino,
    );
  });

  it('predicts a consumer directory at a dropped path exactly as it leaves it', () => {
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

    expect(pruneOutcomes(dryRun.stdout)).toEqual(pruneOutcomes(result.stdout));
    // Here the advice is sound, because the directory really is still there.
    expect(result.stdout).toContain(`left in place ${LEGACY}`);
    expect(result.stdout).toContain('delete it yourself');
    expect(
      readFileSync(join(consumer, `${LEGACY}/team/notes.md`), 'utf8'),
    ).toBe('team notes\n');
  });
});

describe('summing a run that only rewrites the lock', () => {
  it('does not call a retention-only run already in sync', () => {
    // Prune drops the retained key, so the run rewrites `sync-standards.lock`
    // even though it writes nothing else and deletes nothing.
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    write(consumer, `${LEGACY}/team/notes.md`, 'team notes\n');
    writeLockFiles(consumer, {
      ...readLock(consumer),
      [LEGACY]: sha256('gone\n'),
    });

    const dryRun = run(consumer, [
      'sync',
      '--from',
      up,
      '--dir',
      consumer,
      '--dry-run',
    ]);
    const result = run(consumer, ['sync', '--from', up, '--dir', consumer]);

    expect(dryRun.stdout).not.toContain('already in sync');
    expect(dryRun.stdout).toContain(
      'dry run: 0 to create, 0 to update, 0 to delete, 0 to generate, 1 to drop from the lock without deleting',
    );
    expect(pruneOutcomes(dryRun.stdout)).toEqual(pruneOutcomes(result.stdout));
    expect(lockedPaths(consumer)).not.toContain(LEGACY);
  });

  it('does not call a run that only drops a stale link entry already in sync', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    write(consumer, '.agents/skills/notes.md', 'consumer notes\n');
    writeLockFiles(consumer, {
      ...readLock(consumer),
      [`${LINK}/notes.md`]: sha256('consumer notes\n'),
    });

    const dryRun = run(consumer, [
      'sync',
      '--from',
      up,
      '--dir',
      consumer,
      '--dry-run',
    ]);
    const result = run(consumer, ['sync', '--from', up, '--dir', consumer]);

    expect(dryRun.stdout).not.toContain('already in sync');
    expect(dryRun.stdout).toContain('1 to drop from the lock without deleting');
    expect(pruneOutcomes(dryRun.stdout)).toEqual(pruneOutcomes(result.stdout));
    expect(
      readFileSync(join(consumer, '.agents/skills/notes.md'), 'utf8'),
    ).toBe('consumer notes\n');
  });
});
