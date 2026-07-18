import { describe, expect, it } from 'bun:test';
import {
  branchNameForIssue,
  forbiddenDiffPaths,
  isTrustedRole,
} from './poller-protocol';

describe('forbiddenDiffPaths', () => {
  const locked = ['AGENTS.md', 'biome.base.jsonc'];

  it('flags canonical synced files from the lock', () => {
    expect(forbiddenDiffPaths(['AGENTS.md', 'src/app.ts'], locked)).toEqual([
      'AGENTS.md',
    ]);
  });

  it('flags workflows, the sync lock, and encrypted secrets', () => {
    expect(
      forbiddenDiffPaths(
        [
          '.github/workflows/standards.yml',
          'sync-standards.lock',
          'secrets/ci.yaml',
          'secrets/ci.example.yaml',
          'infra/hosts/rs2000/secrets.yaml',
          'infra/hosts/rs2000/secrets.example.yaml',
          '.standards-poller/outcome.json',
        ],
        [],
      ),
    ).toEqual([
      '.github/workflows/standards.yml',
      'sync-standards.lock',
      'secrets/ci.yaml',
      'infra/hosts/rs2000/secrets.yaml',
      '.standards-poller/outcome.json',
    ]);
  });

  it('flags root quality-gate wiring but not workspace package manifests', () => {
    expect(
      forbiddenDiffPaths(
        ['biome.jsonc', 'turbo.json', 'package.json', 'apps/web/package.json'],
        [],
      ),
    ).toEqual(['biome.jsonc', 'turbo.json', 'package.json']);
  });

  it('passes ordinary source changes', () => {
    expect(
      forbiddenDiffPaths(
        [
          'src/features/auth/service.ts',
          'README.md',
          'secrets/dev.example.yaml',
        ],
        locked,
      ),
    ).toEqual([]);
  });
});

describe('trust roles', () => {
  it('trusts only admin and maintain', () => {
    expect(isTrustedRole('admin')).toBe(true);
    expect(isTrustedRole('maintain')).toBe(true);
    expect(isTrustedRole('write')).toBe(false);
    expect(isTrustedRole('triage')).toBe(false);
    expect(isTrustedRole('none')).toBe(false);
  });
});

describe('branchNameForIssue', () => {
  it('derives a stable branch name', () => {
    const issueNumber = 41;
    expect(branchNameForIssue(issueNumber)).toBe('poller/fix-issue-41');
  });
});
