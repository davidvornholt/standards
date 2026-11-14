import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { which } from 'bun';
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
    git(fixture, ['config', 'branch.feature/topic.remote', 'origin']);
    const first = land(fixture, ['123']);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('Deleted branch feature/topic');
    expect(branchExists(fixture)).toBe(false);
    expect(
      git(fixture, ['config', 'branch.feature/topic.remote'], { check: false })
        .status,
    ).not.toBe(0);
    expect(gitOutput(fixture, ['config', 'branch.unrelated.remote'])).toBe(
      'origin',
    );
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

  it('refuses to switch over an ignored file that the base tracks', () => {
    writeFileSync(join(fixture.checkout, 'local.env'), 'base\n');
    git(fixture, ['add', 'local.env']);
    git(fixture, ['commit', '-m', 'track local.env']);
    writeFileSync(join(fixture.checkout, '.git/info/exclude'), 'local.env\n');
    git(fixture, ['switch', 'feature/topic']);
    const target = join(fixture.checkout, 'local.env');
    writeFileSync(target, 'local secret\n');
    const result = land(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('local.env');
    expect(readFileSync(target, 'utf8')).toBe('local secret\n');
    expect(currentBranchOf(fixture)).toBe('feature/topic');
    expect(branchExists(fixture)).toBe(true);
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

describe('standards land keeping a branch a detached worktree uses', () => {
  it('keeps a branch that another worktree is rebasing or bisecting', () => {
    for (const [use, start, finish] of [
      ['being rebased', [['rebase', '--exec', 'false', 'HEAD~1']], 'rebase'],
      [
        'being bisected',
        [
          ['bisect', 'start'],
          ['switch', '--detach'],
        ],
        'bisect',
      ],
    ] as const) {
      const worktree = join(fixture.root, use.replace(' ', '-'));
      git(fixture, ['worktree', 'add', worktree, 'feature/topic']);
      for (const args of start) {
        git(fixture, args, { cwd: worktree, check: false });
      }
      expect(currentBranchOf(fixture, worktree), use).toBe('');
      const result = land(fixture, ['123']);
      expect(result.status, use).not.toBe(0);
      expect(result.stderr).toContain(`${use} at ${JSON.stringify(worktree)}`);
      expect(branchExists(fixture)).toBe(true);
      git(fixture, [finish, finish === 'rebase' ? '--abort' : 'reset'], {
        cwd: worktree,
      });
      git(fixture, ['worktree', 'remove', worktree]);
    }
  });

  it('finds a rebase in a moved worktree or with GIT_DIR set', () => {
    const worktree = join(fixture.root, 'rebasing');
    git(fixture, ['config', 'worktree.useRelativePaths', 'true']);
    git(fixture, ['worktree', 'add', worktree, 'feature/topic']);
    git(fixture, ['rebase', '--exec', 'false', 'HEAD~1'], {
      cwd: worktree,
      check: false,
    });
    fixture.env.GIT_DIR = join(fixture.checkout, '.git');
    const withGitDir = land(fixture, ['123']);
    fixture.env.GIT_DIR = undefined;
    expect(withGitDir.status).not.toBe(0);
    expect(withGitDir.stderr).toContain(
      `being rebased at ${JSON.stringify(worktree)}`,
    );
    renameSync(worktree, `${worktree}-moved`);
    const moved = land(fixture, ['123']);
    expect(moved.status).not.toBe(0);
    expect(moved.stderr).toContain('being rebased');
    expect(branchExists(fixture)).toBe(true);
  });
});

// Puts a git on PATH that runs `command` once, right before the first git
// command whose first two arguments match the shell `pattern`, as another
// agent working in the repository during cleanup would.
const beforeGit = (pattern: string, command: string): void => {
  const realGit = which('git') ?? 'git';
  const done = join(fixture.root, 'interposed');
  const wrapper = join(fixture.root, 'bin', 'git');
  writeFileSync(
    wrapper,
    [
      '#!/bin/sh',
      'case "$1 $2" in',
      `  ${pattern}) [ -e '${done}' ] || { : > '${done}'; PATH='${dirname(realGit)}':"$PATH" ${command}; } ;;`,
      'esac',
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(wrapper, 0o755);
};

describe('standards land racing other work in the repository', () => {
  it('keeps a branch that gains a commit just before its deletion', () => {
    git(fixture, ['switch', '-c', 'unpublished', 'feature/topic']);
    git(fixture, ['commit', '--allow-empty', '-m', 'unpublished']);
    const unpublished = gitOutput(fixture, ['rev-parse', 'HEAD']);
    git(fixture, ['switch', 'trunk']);
    beforeGit(
      '"branch -D"|"update-ref "*',
      `git update-ref refs/heads/feature/topic ${unpublished}`,
    );
    const result = land(fixture, ['123']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('tip changed during cleanup');
    expect(gitOutput(fixture, ['rev-parse', 'refs/heads/feature/topic'])).toBe(
      unpublished,
    );
  });

  it('keeps a branch that this checkout switches to after land starts', () => {
    beforeGit('"worktree list"', 'git switch --quiet feature/topic');
    const result = land(fixture, ['123']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('checked out at');
    expect(branchExists(fixture)).toBe(true);
    expect(currentBranchOf(fixture)).toBe('feature/topic');
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

  it('leaves the base behind when its upstream tracks an ignored file', () => {
    writeFileSync(join(fixture.checkout, 'local.env'), 'base\n');
    git(fixture, ['add', 'local.env']);
    git(fixture, ['commit', '-m', 'track local.env']);
    const merged = addUpstream(fixture);
    git(fixture, ['reset', '--hard', 'HEAD~1']);
    const local = gitOutput(fixture, ['rev-parse', 'trunk']);
    writeFileSync(join(fixture.checkout, '.git/info/exclude'), 'local.env\n');
    const target = join(fixture.checkout, 'local.env');
    writeFileSync(target, 'local secret\n');
    const result = land(fixture, ['123']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Could not fast-forward "trunk"');
    expect(readFileSync(target, 'utf8')).toBe('local secret\n');
    expect(gitOutput(fixture, ['rev-parse', 'trunk'])).toBe(local);
    expect(gitOutput(fixture, ['rev-parse', 'origin/trunk'])).toBe(merged);
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
