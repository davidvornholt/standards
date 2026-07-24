import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ApprovalBinding } from './poller-approval';

const REPO = 'owner/repo';
const ISSUE_NUMBER = 7;

export const createTestApproval = (
  label: string,
  target: string,
): ApprovalBinding => {
  const fields = {
    repo: REPO,
    issueNumber: ISSUE_NUMBER,
    eventId: 101,
    label,
    actorLogin: 'maintainer',
    approvedAt: '2026-07-18T10:00:00Z',
    target,
  };
  return {
    id: createHash('sha256').update(JSON.stringify(fields)).digest('hex'),
    ...fields,
  };
};

const git = (cwd: string, args: ReadonlyArray<string>): string =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
  }).trim();

const commit = (repo: string, message: string): void => {
  git(repo, ['add', '-A']);
  git(repo, [
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-qm',
    message,
  ]);
};

export type LocalPollerRepo = {
  readonly baseSha: string;
  readonly cacheDir: string;
  readonly cacheRepo: string;
  readonly headSha: string;
  readonly root: string;
  readonly source: string;
};

export const createLocalPollerRepo = (): LocalPollerRepo => {
  const root = mkdtempSync(join(tmpdir(), 'poller-job-entrypoint-'));
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  const cacheDir = join(root, 'cache');
  const cacheRepo = join(cacheDir, `${REPO}.git`);
  mkdirSync(source);
  git(source, ['init', '-q']);
  writeFileSync(join(source, 'file.txt'), 'base\n');
  commit(source, 'base');
  git(source, ['branch', '-M', 'main']);
  const baseSha = git(source, ['rev-parse', 'HEAD']);
  git(source, ['checkout', '-qb', 'feature']);
  writeFileSync(join(source, 'feature.txt'), 'feature\n');
  commit(source, 'feature');
  const headSha = git(source, ['rev-parse', 'HEAD']);
  git(root, ['init', '--bare', '-q', remote]);
  git(source, ['remote', 'add', 'origin', remote]);
  git(source, ['push', '-q', 'origin', 'main', 'feature']);

  mkdirSync(dirname(cacheRepo), { recursive: true });
  git(root, ['init', '--bare', '-q', cacheRepo]);
  git(cacheRepo, [
    'config',
    'remote.origin.fetch',
    '+refs/heads/*:refs/heads/*',
  ]);
  git(cacheRepo, [
    'config',
    `url.file://${remote}.insteadOf`,
    `https://github.com/${REPO}.git`,
  ]);
  git(cacheRepo, [
    'config',
    'remote.origin.url',
    `https://github.com/${REPO}.git`,
  ]);
  return { baseSha, cacheDir, cacheRepo, headSha, root, source };
};

export const pushRef = (
  source: string,
  remoteBranch: string,
  sourceRef = 'HEAD',
): void => {
  git(source, [
    'push',
    '-q',
    'origin',
    `${sourceRef}:refs/heads/${remoteBranch}`,
  ]);
};

export const checkout = (source: string, ref: string): void => {
  git(source, ['checkout', '--detach', '-q', ref]);
};

export const commitFile = (
  source: string,
  path: string,
  content: string,
): string => {
  writeFileSync(join(source, path), content);
  commit(source, `change ${path}`);
  return git(source, ['rev-parse', 'HEAD']);
};
