import { afterEach, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { resolveGithubRepo } from './github-api';
import { openRepositoryRoot } from './sync-filesystem';

const roots: Array<string> = [];
const originalGitDirectory = process.env.GIT_DIR;

afterEach(() => {
  if (originalGitDirectory === undefined) {
    delete process.env.GIT_DIR;
  } else {
    process.env.GIT_DIR = originalGitDirectory;
  }
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

const repository = (remote: string): string => {
  const root = mkdtempSync(join(tmpdir(), 'github-api-environment-'));
  roots.push(root);
  execFileSync('git', ['-C', root, 'init', '--quiet', '-b', 'main']);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remote]);
  return root;
};

it('resolves the opened root origin despite an inherited GIT_DIR', async () => {
  const consumer = repository('https://github.com/example/consumer.git');
  const victim = repository('https://github.com/example/victim.git');
  const victimGit = join(victim, '.git');
  const before = {
    config: readFileSync(join(victimGit, 'config')),
    entries: readdirSync(victimGit).sort(),
    head: readFileSync(join(victimGit, 'HEAD')),
  };
  process.env.GIT_DIR = victimGit;

  expect(
    await resolveGithubRepo(await openRepositoryRoot(consumer, 'consumer')),
  ).toBe('example/consumer');

  expect(readFileSync(join(victimGit, 'config'))).toEqual(before.config);
  expect(readFileSync(join(victimGit, 'HEAD'))).toEqual(before.head);
  expect(readdirSync(victimGit).sort()).toEqual(before.entries);
});
