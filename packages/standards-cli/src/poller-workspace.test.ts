import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { readSealedFixOutput, sealFixOutput } from './poller-fix-output';
import { lockedPathsOf } from './poller-protected-paths';
import {
  ensureCacheClone,
  githubRepoUrl,
  pushBranch,
} from './poller-workspace';

const dirs: Array<string> = [];
const originalPath = process.env.PATH;

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'poller-workspace-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('authenticated git remotes', () => {
  it('ignores a mutated origin for fetch and push', () => {
    const root = tempDir();
    const bin = join(root, 'bin');
    const log = join(root, 'git.log');
    const cache = join(root, 'cache');
    mkdirSync(bin);
    mkdirSync(join(cache, 'owner/repo.git'), { recursive: true });
    const fakeGit = join(bin, 'git');
    writeFileSync(fakeGit, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$GIT_LOG"\n`);
    execFileSync('chmod', ['+x', fakeGit]);
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    process.env.GIT_LOG = log;

    ensureCacheClone(cache, 'owner/repo', 'secret');
    pushBranch(root, {
      repo: 'owner/repo',
      branch: 'topic',
      token: 'secret',
      expectedRemoteSha: '',
    });

    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain(
      `fetch --prune ${githubRepoUrl('owner/repo')} +refs/heads/*:refs/heads/*`,
    );
    expect(calls).toContain(
      `push --force-with-lease=refs/heads/topic: ${githubRepoUrl('owner/repo')} HEAD:refs/heads/topic`,
    );
    expect(calls).not.toContain('fetch --prune origin');
    expect(calls).not.toContain('push origin');
  });
});

describe('lockedPathsOf', () => {
  it('distinguishes an absent lock from a malformed consumer lock', async () => {
    const root = tempDir();
    expect(await lockedPathsOf(root)).toEqual([]);
    writeFileSync(join(root, 'sync-standards.lock'), '{"files":[]}');
    expect(lockedPathsOf(root)).rejects.toThrow('cannot trust protected paths');
  });
});

describe('sealed fix output', () => {
  it('round-trips durable output through the branch tip', () => {
    const root = tempDir();
    execFileSync('git', ['init', '-q', root]);
    writeFileSync(join(root, 'file.txt'), 'initial\n');
    execFileSync('git', ['-C', root, 'add', 'file.txt']);
    execFileSync('git', [
      '-C',
      root,
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-qm',
      'initial',
    ]);
    execFileSync('git', ['-C', root, 'branch', '-M', 'owned']);

    const sealed = sealFixOutput(root, {
      issueNumber: 4,
      approvalId: 'approval',
      title: 'fix(cli): repair poller',
      body: 'Body',
    });

    expect(readSealedFixOutput(root, 'owned')).toEqual(sealed);
    expect(sealed.generatedHead).not.toBe(sealed.sealedHead);
  });
});
