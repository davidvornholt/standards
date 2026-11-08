import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { cleanupTmpDirs } from './cli-test-support';
import {
  addUpstream,
  branchExists,
  calls,
  createLand,
  currentBranchOf,
  git,
  gitOutput,
  type Land,
  land,
  mergeCalls,
} from './land-test-support';

let fixture: Land;

beforeEach(() => {
  fixture = createLand(process.env);
});

afterEach(() => {
  cleanupTmpDirs();
});

describe('standards land deleting a merged branch', () => {
  it('deletes only the requested branch, once', () => {
    git(fixture, ['branch', 'unrelated', 'feature/topic']);
    git(fixture, ['config', 'branch.unrelated.remote', 'origin']);
    git(fixture, ['config', 'branch.unrelated.merge', 'refs/heads/gone']);
    const first = land(fixture, ['123']);
    expect(first.status, first.stderr).toBe(0);
    expect(branchExists(fixture)).toBe(false);
    git(fixture, ['show-ref', '--verify', 'refs/heads/unrelated']);
    expect(currentBranchOf(fixture)).toBe('trunk');
    const second = land(fixture, ['123']);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('already absent');
    expect(mergeCalls(fixture)).toEqual([]);
  });

  it('switches from the current branch to a base other than main', () => {
    git(fixture, ['switch', 'feature/topic']);
    const result = land(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(branchExists(fixture)).toBe(false);
    expect(currentBranchOf(fixture)).toBe('trunk');
    expect(calls(fixture)[1]?.[2]).toBe('feature/topic');
  });

  it('detaches a linked worktree when another checkout holds the base', () => {
    const worktree = join(fixture.root, 'topic');
    git(fixture, ['worktree', 'add', worktree, 'feature/topic']);
    const result = land(fixture, [], worktree);
    expect(result.status, result.stderr).toBe(0);
    expect(branchExists(fixture)).toBe(false);
    expect(currentBranchOf(fixture, worktree)).toBe('');
    expect(gitOutput(fixture, ['rev-parse', 'HEAD'], worktree)).toBe(
      String(fixture.pr.headRefOid),
    );
  });

  it('needs a selector on a detached HEAD', () => {
    git(fixture, ['switch', '--detach']);
    const bare = land(fixture);
    expect(bare.status).not.toBe(0);
    expect(bare.stderr).toContain('Detached HEAD');
    const selected = land(fixture, ['123']);
    expect(selected.status, selected.stderr).toBe(0);
  });

  it("uses the checkout's repository even with GH_REPO set", () => {
    fixture.env.GH_REPO = 'other/repo';
    const result = land(fixture, ['https://github.com/test/repo/pull/123']);
    expect(result.status, result.stderr).toBe(0);
  });
});

describe('standards land keeping a branch with local work', () => {
  it('names the other worktree that holds a branch with a gone upstream', () => {
    const worktree = join(fixture.root, 'linked tree\nwith newline');
    git(fixture, ['worktree', 'add', worktree, 'feature/topic']);
    git(fixture, ['remote', 'add', 'origin', 'https://github.com/test/repo']);
    git(fixture, ['config', 'branch.feature/topic.remote', 'origin']);
    git(fixture, [
      'config',
      'branch.feature/topic.merge',
      'refs/heads/feature/topic',
    ]);
    expect(git(fixture, ['branch', '-vv']).stdout).toContain('+ feature/topic');
    const result = land(fixture, ['123']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(JSON.stringify(worktree));
    expect(result.stderr).not.toContain("branch '+' not found");
    expect(existsSync(worktree)).toBe(true);
    expect(branchExists(fixture)).toBe(true);
  });

  it('keeps a branch with extra local commits', () => {
    git(fixture, ['switch', 'feature/topic']);
    git(fixture, ['commit', '--allow-empty', '-m', 'unpublished']);
    const result = land(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("tip isn't part of merged PR #123");
    expect(branchExists(fixture)).toBe(true);
  });

  it('refuses to switch away from changed or untracked files', () => {
    git(fixture, ['switch', 'feature/topic']);
    for (const name of ['tracked', 'untracked']) {
      const target = join(fixture.checkout, name);
      writeFileSync(target, 'local work\n');
      const result = land(fixture);
      expect(result.status, name).not.toBe(0);
      expect(result.stderr).toContain('Commit or stash');
      expect(readFileSync(target, 'utf8')).toBe('local work\n');
      expect(branchExists(fixture)).toBe(true);
      if (name === 'tracked') {
        git(fixture, ['restore', 'tracked']);
      } else {
        rmSync(target);
      }
    }
  });

  it('keeps a branch that a checkout hook moves', () => {
    git(fixture, ['switch', 'feature/topic']);
    const hook = join(fixture.checkout, '.git/hooks/post-checkout');
    writeFileSync(
      hook,
      '#!/bin/sh\ngit update-ref refs/heads/feature/topic refs/heads/trunk\n',
    );
    chmodSync(hook, 0o755);
    const result = land(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('tip changed during cleanup');
    expect(branchExists(fixture)).toBe(true);
  });
});

describe('standards land keeping a branch it may not delete', () => {
  it('keeps the branch of a closed, foreign, or fork pull request', () => {
    for (const overrides of [
      { state: 'CLOSED' },
      { state: 'OPEN', url: 'https://github.com/other/repo/pull/123' },
      { isCrossRepository: true },
    ]) {
      const original = fixture.pr;
      fixture.pr = { ...original, ...overrides };
      expect(land(fixture, ['123']).status, JSON.stringify(overrides)).not.toBe(
        0,
      );
      expect(branchExists(fixture)).toBe(true);
      expect(mergeCalls(fixture)).toEqual([]);
      fixture.pr = original;
    }
  });

  it('protects the default and base branches', () => {
    for (const overrides of [
      { headRefName: 'trunk' },
      { baseRefName: 'feature/topic' },
    ]) {
      const original = fixture.pr;
      fixture.pr = { ...original, ...overrides };
      const result = land(fixture, ['123']);
      expect(result.status, JSON.stringify(overrides)).not.toBe(0);
      expect(result.stderr).toContain('base or default branch');
      expect(branchExists(fixture)).toBe(true);
      fixture.pr = original;
    }
  });

  it('stays on the current branch when the base is not local', () => {
    git(fixture, ['switch', 'feature/topic']);
    fixture.pr.baseRefName = 'missing';
    const result = land(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('is not local');
    expect(branchExists(fixture)).toBe(true);
  });

  it('keeps the branch when GitHub fails', () => {
    fixture.env.GH_FAIL = '1';
    const result = land(fixture, ['123']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('GitHub unavailable');
    expect(branchExists(fixture)).toBe(true);
  });
});

describe('standards land updating the base', () => {
  it('fast-forwards the base from its upstream', () => {
    const merged = addUpstream(fixture);
    git(fixture, ['reset', '--hard', 'HEAD~1']);
    git(fixture, ['switch', 'feature/topic']);
    const result = land(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(currentBranchOf(fixture)).toBe('trunk');
    expect(gitOutput(fixture, ['rev-parse', 'trunk'])).toBe(merged);
    expect(branchExists(fixture)).toBe(false);
  });

  it('leaves a diverged base unmerged', () => {
    const merged = addUpstream(fixture);
    git(fixture, ['reset', '--hard', 'HEAD~1']);
    git(fixture, ['commit', '--allow-empty', '-m', 'local base work']);
    const local = gitOutput(fixture, ['rev-parse', 'trunk']);
    const result = land(fixture, ['123']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Could not fast-forward "trunk"');
    expect(gitOutput(fixture, ['rev-parse', 'trunk'])).toBe(local);
    expect(local).not.toBe(merged);
    expect(branchExists(fixture)).toBe(false);
  });
});

describe('standards land cleaning up after its own merge', () => {
  it('only warns when local cleanup fails', () => {
    fixture.pr.state = 'OPEN';
    git(fixture, ['switch', 'feature/topic']);
    git(fixture, ['commit', '--allow-empty', '-m', 'unpublished']);
    const result = land(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      'PR #123 is merged, but local cleanup stopped',
    );
    expect(result.stderr).toContain("tip isn't part of merged PR #123");
    expect(branchExists(fixture)).toBe(true);
  });

  it('warns when GitHub keeps merged branches', () => {
    fixture.pr.state = 'OPEN';
    fixture.env.GH_KEEPS_BRANCHES = '1';
    const result = land(fixture, ['123']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('Automatically delete head branches');
  });
});
