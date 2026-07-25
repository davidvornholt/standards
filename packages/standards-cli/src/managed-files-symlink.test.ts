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
import {
  cleanupTmpDirs,
  mkTmp,
  type RunResult,
  runProcess,
  write,
} from './cli-test-support';

const ENGINE = join(import.meta.dir, 'cli.ts');
const LINK = '.claude/skills';
const TARGET = '../.agents/skills';
const SKILL = '.agents/skills/probe/SKILL.md';

const run = (cwd: string, args: ReadonlyArray<string>): RunResult =>
  runProcess('bun', cwd, [ENGINE, ...args], { ...process.env });

// An upstream whose managed payload is a skills directory plus a symlink that
// points at it from the directory Claude Code actually scans.
const buildUpstream = (target: string = TARGET): string => {
  const up = mkTmp('symlink-up-');
  write(
    up,
    'sync-standards.json',
    JSON.stringify({
      upstream: up,
      seedDir: 'template',
      paths: [
        'sync-standards.json',
        '.github/dependabot.base.yml',
        '.agents/skills',
        LINK,
      ],
    }),
  );
  write(up, 'template/seed.txt', 'seed original\n');
  write(
    up,
    '.github/dependabot.base.yml',
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
  write(up, SKILL, '---\nname: probe\n---\n');
  mkdirSync(join(up, '.claude'), { recursive: true });
  symlinkSync(target, join(up, LINK));
  return up;
};

const initConsumer = (up: string): { consumer: string; result: RunResult } => {
  const consumer = mkTmp('symlink-cons-');
  return {
    consumer,
    result: run(consumer, ['init', '--from', up, '--dir', consumer]),
  };
};

const lockedPaths = (consumer: string): ReadonlyArray<string> =>
  Object.keys(
    (
      JSON.parse(
        readFileSync(join(consumer, 'sync-standards.lock'), 'utf8'),
      ) as { files: Record<string, string> }
    ).files,
  );

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

  it('refuses a canonical symlink whose target escapes the repository', () => {
    const { consumer, result } = initConsumer(buildUpstream('../../../etc'));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `canonical symlink ${LINK} must point inside the repository`,
    );
    expect(lstatSync(join(consumer, LINK), { throwIfNoEntry: false })).toBe(
      undefined,
    );
  });
});
