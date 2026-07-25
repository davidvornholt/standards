// Shared fixture for the suites that exercise symlinks as managed paths: an
// upstream whose managed payload is a skills directory plus a link that points
// at it from the directory Claude Code actually scans. Callers compose the
// child-process environment so this module stays free of ambient process access.

import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkTmp, type RunResult, runProcess, write } from './cli-test-support';

export const ENGINE = join(import.meta.dir, 'cli.ts');
export const LINK = '.claude/skills';
export const TARGET = '../.agents/skills';
export const SKILL = '.agents/skills/probe/SKILL.md';

const DEPENDABOT_BASE = [
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
].join('\n');

type Engine = {
  readonly run: (cwd: string, args: ReadonlyArray<string>) => RunResult;
  readonly initConsumer: (up: string) => {
    consumer: string;
    result: RunResult;
  };
};

// Bind the engine to one environment, so a suite names the environment once
// instead of at every call.
export const engineFor = (
  env: Readonly<Record<string, string | undefined>>,
): Engine => {
  const run = (cwd: string, args: ReadonlyArray<string>): RunResult =>
    runProcess('bun', cwd, [ENGINE, ...args], env);
  return {
    initConsumer: (up: string) => {
      const consumer = mkTmp('symlink-cons-');
      return {
        consumer,
        result: run(consumer, ['init', '--from', up, '--dir', consumer]),
      };
    },
    run,
  };
};

type UpstreamOptions = {
  readonly target: string;
  // `false` drops the link from the manifest, so a suite can build the pre-link
  // payload an older CLI synced before this shape existed.
  readonly linked: boolean;
  // Extra managed files, for suites that need a path upstream can later drop.
  readonly extra: ReadonlyArray<string>;
};

export const buildUpstream = ({
  target = TARGET,
  linked = true,
  extra = [],
}: Partial<UpstreamOptions> = {}): string => {
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
        ...(linked ? [LINK] : []),
        ...extra,
      ],
    }),
  );
  write(up, 'template/seed.txt', 'seed original\n');
  write(up, '.github/dependabot.base.yml', DEPENDABOT_BASE);
  write(up, SKILL, '---\nname: probe\n---\n');
  for (const rel of extra) {
    write(up, rel, `canonical ${rel}\n`);
  }
  if (linked) {
    mkdirSync(join(up, '.claude'), { recursive: true });
    symlinkSync(target, join(up, LINK));
  }
  return up;
};

export const readLock = (consumer: string): Record<string, string> =>
  (
    JSON.parse(readFileSync(join(consumer, 'sync-standards.lock'), 'utf8')) as {
      files: Record<string, string>;
    }
  ).files;

export const lockedPaths = (consumer: string): ReadonlyArray<string> =>
  Object.keys(readLock(consumer));

// Replace the lock's file map, preserving the rest. Lets a suite hand the
// engine a lock it did not just write itself.
export const writeLockFiles = (
  consumer: string,
  files: Record<string, string>,
): void => {
  const path = join(consumer, 'sync-standards.lock');
  const lock = JSON.parse(readFileSync(path, 'utf8')) as Record<
    string,
    unknown
  >;
  writeFileSync(path, `${JSON.stringify({ ...lock, files }, null, 2)}\n`);
};
