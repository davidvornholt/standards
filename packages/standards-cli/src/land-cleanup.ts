// Local cleanup after a merge: delete the pull request's local branch when
// every commit on it is part of the merged pull request, and fast-forward a
// checkout on the base branch.

import {
  currentBranch,
  git,
  type LandContext,
  LandError,
  type PullRequest,
  quoted,
  type Repository,
  resolvedPath,
  run,
  runVisibly,
} from './land-context';

export type Checkout = {
  // The resolved top level of the checkout land runs in.
  readonly root: string;
  // Its branch when land started, or null when HEAD was detached.
  readonly current: string | null;
};

type Worktree = Readonly<Record<string, string>>;

// The pull request's head contains the local tip when they match or GitHub's
// compare API finds the tip in its history, as after `gh pr update-branch`.
const containedInPr = (
  context: LandContext,
  tip: string,
  pr: PullRequest,
  repo: Repository,
): boolean => {
  if (tip === pr.headRefOid) {
    return true;
  }
  const result = run(
    context,
    'gh',
    [
      'api',
      `repos/${repo.nameWithOwner}/compare/${tip}...${pr.headRefOid}`,
      '--jq',
      '.status',
    ],
    false,
  );
  const status = result.stdout.trim();
  return result.status === 0 && (status === 'ahead' || status === 'identical');
};

// Porcelain with NUL delimiters preserves paths containing spaces and
// newlines and has none of the decorations of `git branch -vv`.
const listWorktrees = (context: LandContext): ReadonlyArray<Worktree> =>
  git(context, 'worktree', 'list', '--porcelain', '-z')
    .split('\0\0')
    .map((record) =>
      Object.fromEntries(
        record
          .split('\0')
          .filter((field) => field.includes(' '))
          .map((field) => {
            const space = field.indexOf(' ');
            return [field.slice(0, space), field.slice(space + 1)];
          }),
      ),
    )
    .filter((fields) => Object.keys(fields).length > 0);

// Returns the local branch's tip, or null when the branch is already absent.
const localTip = (context: LandContext, ref: string): string | null => {
  const local = run(
    context,
    'git',
    ['rev-parse', '--verify', '--quiet', ref],
    false,
  );
  if (local.status === 1) {
    return null;
  }
  if (local.status !== 0) {
    throw new LandError(
      local.stderr.trim() || 'Cannot resolve the local branch.',
    );
  }
  return local.stdout.trim();
};

const branchToDelete = (pr: PullRequest, repo: Repository): string => {
  if (pr.isCrossRepository) {
    throw new LandError('Fork PRs require manual local branch cleanup.');
  }
  const branch = pr.headRefName;
  const defaultBranch = repo.defaultBranchRef?.name;
  if (!defaultBranch) {
    throw new LandError("Cannot determine the repository's default branch.");
  }
  if (branch === pr.baseRefName || branch === defaultBranch) {
    throw new LandError(
      `Refusing to delete the base or default branch ${quoted(branch)}.`,
    );
  }
  return branch;
};

// Leaves the branch that is about to be deleted.
const leaveBranch = (
  context: LandContext,
  base: string,
  worktrees: ReadonlyArray<Worktree>,
): void => {
  if (git(context, 'status', '--porcelain', '--untracked-files=all')) {
    throw new LandError(
      'Commit or stash changes (including untracked files) before switching branches.',
    );
  }
  if (worktrees.some((worktree) => worktree.branch === `refs/heads/${base}`)) {
    // Another checkout holds the base, so leave this one detached at the
    // same commit; remove the finished worktree when done.
    git(context, 'switch', '--detach');
    return;
  }
  // Do not fetch, create a base branch, or guess a remote during cleanup.
  const baseRef = `refs/heads/${base}`;
  if (
    run(context, 'git', ['show-ref', '--verify', '--quiet', baseRef], false)
      .status !== 0
  ) {
    throw new LandError(
      `Base branch ${quoted(base)} is not local. Switch to another branch, then retry.`,
    );
  }
  git(context, 'switch', '--no-guess', '--', base);
};

export const deleteBranch = (
  context: LandContext,
  pr: PullRequest,
  repo: Repository,
  checkout: Checkout,
): void => {
  const branch = branchToDelete(pr, repo);
  git(context, 'check-ref-format', '--branch', branch);
  const ref = `refs/heads/${branch}`;
  const tip = localTip(context, ref);
  if (tip === null) {
    context.print(`Local branch ${quoted(branch)} is already absent.`);
    return;
  }
  if (!containedInPr(context, tip, pr, repo)) {
    throw new LandError(
      `Keeping ${quoted(branch)}: its tip isn't part of merged PR #${pr.number}. It may contain additional or rewritten work.`,
    );
  }
  const worktrees = listWorktrees(context);
  const elsewhere = worktrees.find(
    (worktree) =>
      worktree.branch === ref &&
      resolvedPath(worktree.worktree ?? '') !== checkout.root,
  );
  if (elsewhere !== undefined) {
    throw new LandError(
      `Keeping ${quoted(branch)}: checked out at ${quoted(elsewhere.worktree ?? '')}. ` +
        'Switch that worktree to another branch, or remove it explicitly, then retry.',
    );
  }
  if (checkout.current === branch) {
    leaveBranch(context, pr.baseRefName, worktrees);
  }
  // Recheck after switching, which can run user hooks. Squash merges need -D
  // because the original commits are not ancestors of the merge commit.
  if (git(context, 'rev-parse', '--verify', ref) !== tip) {
    throw new LandError(
      `Keeping ${quoted(branch)}: its tip changed during cleanup.`,
    );
  }
  context.print(git(context, 'branch', '-D', '--', branch));
};

// The merge happened on GitHub, so a checkout on the base is now behind. Only
// fast-forward it; bases in other worktrees are left alone.
export const updateBase = (context: LandContext, base: string): void => {
  if (currentBranch(context) !== base) {
    return;
  }
  if (
    run(
      context,
      'git',
      ['rev-parse', '--verify', '--quiet', '@{upstream}'],
      false,
    ).status !== 0
  ) {
    return;
  }
  if (!runVisibly(context, 'git', ['pull', '--ff-only', '--prune'])) {
    throw new LandError(
      `Could not fast-forward ${quoted(base)}; update it manually.`,
    );
  }
};
