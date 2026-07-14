import { describe, expect, it } from 'bun:test';
import { githubRepositoryFromRemote } from './github-api';

describe('GitHub origin parsing', () => {
  it.each([
    ['https://github.com/owner/repository.git', 'owner/repository'],
    ['https://github.com/Owner/repository', 'Owner/repository'],
    ['ssh://git@github.com/owner/repository.git', 'owner/repository'],
    ['ssh://git@github.com:22/owner/repository', 'owner/repository'],
    ['git@github.com:owner/repository.git', 'owner/repository'],
  ] as const)('accepts supported remote %s', (remote, expected) => {
    expect(githubRepositoryFromRemote(remote)).toBe(expected);
  });

  it.each([
    'https://evil.example/github.com/victim/repo.git',
    'https://github.com.evil.example/victim/repo.git',
    'https://github.com@evil.example/victim/repo.git',
    'https://token@github.com/victim/repo.git',
    'http://github.com/victim/repo.git',
    'ssh://user@github.com/victim/repo.git',
    'git@example.com:github.com/victim/repo.git',
    'git@github.com:missing-repository',
    'git@github.com:owner/repo/extra.git',
    'git@github.com:-owner/repo.git',
    'git@github.com:owner/..git',
    'git@github.com:owner/repo.git?query',
  ])('rejects unsupported or malformed remote %s', (remote) => {
    expect(githubRepositoryFromRemote(remote)).toBeNull();
  });
});
