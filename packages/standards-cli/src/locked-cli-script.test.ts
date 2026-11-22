// The synced script that runs a core consumer's standards CLI from the commit
// its lock records, against a local upstream that Git reaches in place of
// GitHub.

import { afterEach, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  ACTUAL_UPSTREAM,
  cleanupTmpDirs,
  mkTmp,
  type RunResult,
  runProcess,
  write,
} from './cli-test-support';

afterEach(cleanupTmpDirs);

const SCRIPT = join(
  ACTUAL_UPSTREAM,
  '.agents/skills/standards-sync/scripts/standards.sh',
);
const REPOSITORY = 'owner/standards';

const git = (cwd: string, args: ReadonlyArray<string>): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

// An upstream whose CLI prints the version it was committed with, so a test
// can tell which commit ran.
const commitUpstream = (up: string, version: string): string => {
  write(
    up,
    'packages/standards-cli/src/cli.ts',
    `console.log(JSON.stringify({ version: '${version}', args: process.argv.slice(2), cwd: process.cwd(), env: process.env.FROM_DOTENV ?? null }));\n`,
  );
  git(up, ['add', '-A']);
  git(up, ['commit', '--quiet', '-m', version]);
  return git(up, ['rev-parse', 'HEAD']);
};

const buildUpstream = (): string => {
  const up = mkTmp('locked-cli-up-');
  git(up, ['init', '--quiet']);
  git(up, ['config', 'user.email', 'test@example.com']);
  git(up, ['config', 'user.name', 'test']);
  write(
    up,
    'package.json',
    '{ "name": "root", "private": true, "packageManager": "bun@1.4.5", "workspaces": ["packages/*"] }\n',
  );
  write(
    up,
    'packages/standards-cli/package.json',
    '{ "name": "@davidvornholt/standards", "version": "0.0.0" }\n',
  );
  execFileSync('bun', ['install', '--silent'], { cwd: up });
  return up;
};

const consumerAt = (sha: string, upstream = `github:${REPOSITORY}`): string => {
  const consumer = mkTmp('locked-cli-cons-');
  write(
    consumer,
    'sync-standards.lock',
    JSON.stringify({ upstream, sha, files: {} }),
  );
  write(consumer, '.env', 'FROM_DOTENV=leaked\n');
  return consumer;
};

const runScript = (
  cwd: string,
  up: string,
  cache: string,
  args: ReadonlyArray<string>,
): RunResult =>
  runProcess('bash', cwd, [SCRIPT, ...args], {
    ...process.env,
    ...Object.fromEntries([
      ['XDG_CACHE_HOME', cache],
      ['GIT_CONFIG_COUNT', '1'],
      ['GIT_CONFIG_KEY_0', `url.file://${up}.insteadOf`],
      ['GIT_CONFIG_VALUE_0', `https://github.com/${REPOSITORY}.git`],
    ]),
  });

// The JSON line the fake CLI printed, or a throw with the script's stderr.
const ranVersion = (result: RunResult): Record<string, unknown> => {
  if (result.status !== 0) {
    throw new Error(`standards.sh exited ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '') as Record<
    string,
    unknown
  >;
};

it('runs the CLI of the locked commit, not the newest one', () => {
  const up = buildUpstream();
  const locked = commitUpstream(up, 'locked');
  commitUpstream(up, 'newer');
  const consumer = consumerAt(locked);
  const cache = mkTmp('locked-cli-cache-');

  const output = ranVersion(
    runScript(consumer, up, cache, ['check', '--dir', '.']),
  );

  expect(output).toEqual({
    version: 'locked',
    args: ['check', '--dir', '.'],
    cwd: consumer,
    env: null,
  });
});

it('reuses an installed commit without fetching it again', () => {
  const up = buildUpstream();
  const locked = commitUpstream(up, 'locked');
  const consumer = consumerAt(locked);
  const cache = mkTmp('locked-cli-cache-');
  ranVersion(runScript(consumer, up, cache, ['check']));

  rmSync(up, { recursive: true, force: true });

  expect(ranVersion(runScript(consumer, up, cache, ['check'])).version).toBe(
    'locked',
  );
  expect(
    existsSync(
      join(cache, 'davidvornholt-standards/cli', `owner-standards-${locked}`),
    ),
  ).toBe(true);
});

it('stops outside the repository root', () => {
  const result = runScript(mkTmp('locked-cli-empty-'), '/nowhere', '/nowhere', [
    'check',
  ]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('run it from the repository root');
});

it.each([
  ['an upstream outside GitHub', 'a'.repeat(40), 'https://example.com/x.git'],
  ['an upstream path that leaves its owner', 'a'.repeat(40), 'github:owner/..'],
  ['an abbreviated commit', 'abc1234', `github:${REPOSITORY}`],
])('refuses a lock with %s', (_name, sha, upstream) => {
  const result = runScript(
    consumerAt(sha, upstream),
    '/nowhere',
    mkTmp('locked-cli-cache-'),
    ['check'],
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('standards.sh: sync-standards.lock must');
});
