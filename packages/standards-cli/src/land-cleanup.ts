// Local cleanup after a merge: delete the pull request's local branch when
// every commit on it is part of the merged pull request, and fast-forward a
// checkout on the base branch.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  currentBranch,
  errorMessage,
  git,
  type LandContext,
  LandError,
  type PullRequest,
  quoted,
  type Repository,
  resolvedPath,
  run,
  runVisibly,
  shortSha,
  viewPr,
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
  // `git status` doesn't list ignored files, and `git switch` overwrites one
  // that the base tracks unless told not to.
  const baseRef = `refs/heads/${base}`;
  if (
    run(context, 'git', ['show-ref', '--verify', '--quiet', baseRef], false)
      .status !== 0
  ) {
    throw new LandError(
      `Base branch ${quoted(base)} is not local. Switch to another branch, then retry.`,
    );
  }
  git(context, 'switch', '--no-guess', '--no-overwrite-ignore', '--', base);
};

// A worktree's Git directory and its folder. The main worktree's is the
// common directory, and each linked worktree's is under its `worktrees`
// folder, which outlives a linked worktree's moved or deleted folder.
type WorktreeGitDir = { readonly gitDir: string; readonly path: string };

const worktreeGitDirs = (
  context: LandContext,
  worktrees: ReadonlyArray<Worktree>,
): ReadonlyArray<WorktreeGitDir> => {
  const common = git(
    context,
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  );
  const linked = join(common, 'worktrees');
  const names = existsSync(linked) ? readdirSync(linked) : [];
  return [
    // Git lists the main worktree first.
    { gitDir: common, path: worktrees[0]?.worktree ?? common },
    ...names.map((name) => {
      const gitDir = join(linked, name);
      const link = join(gitDir, 'gitdir');
      return {
        gitDir,
        path: existsSync(link)
          ? dirname(resolve(gitDir, readFileSync(link, 'utf8').trim()))
          : gitDir,
      };
    }),
  ];
};

// What a worktree does with the branch from a detached HEAD that makes `git
// branch -D` refuse to delete it, read from the files Git keeps for it.
const detachedUse = (gitDir: string, ref: string): string | null => {
  const state = (name: string): string | null => {
    const path = join(gitDir, name);
    return existsSync(path) ? readFileSync(path, 'utf8').trim() : null;
  };
  if (
    state('rebase-merge/head-name') === ref ||
    state('rebase-apply/head-name') === ref
  ) {
    return 'being rebased';
  }
  return state('BISECT_START') === ref.slice('refs/heads/'.length)
    ? 'being bisected'
    : null;
};

// Refuses to delete a branch that a worktree other than `except` has checked
// out, or that any worktree is rebasing or bisecting.
const keepIfInUse = (
  context: LandContext,
  branch: string,
  except: string | null,
): void => {
  const ref = `refs/heads/${branch}`;
  const worktrees = listWorktrees(context);
  const holder = worktrees.find(
    (worktree) =>
      worktree.branch === ref &&
      resolvedPath(worktree.worktree ?? '') !== except,
  );
  if (holder !== undefined) {
    throw new LandError(
      `Keeping ${quoted(branch)}: checked out at ${quoted(holder.worktree ?? '')}. ` +
        'Switch that worktree to another branch, or remove it explicitly, then retry.',
    );
  }
  for (const { gitDir, path } of worktreeGitDirs(context, worktrees)) {
    const use = detachedUse(gitDir, ref);
    if (use !== null) {
      throw new LandError(
        `Keeping ${quoted(branch)}: ${use} at ${quoted(path)}. Finish or abort that there, then retry.`,
      );
    }
  }
};

// Deletes the branch only while it still points at the checked tip, so a
// commit made during cleanup, by a hook or another agent, survives. `git
// branch -D` can't make the deletion conditional, so this does its two steps:
// the ref, including its reflog, and then the branch's configuration.
const removeBranch = (
  context: LandContext,
  branch: string,
  tip: string,
): void => {
  const ref = `refs/heads/${branch}`;
  const deletion = run(
    context,
    'git',
    ['update-ref', '--no-deref', '-d', ref, tip],
    false,
  );
  if (deletion.status !== 0) {
    if (localTip(context, ref) !== tip) {
      throw new LandError(
        `Keeping ${quoted(branch)}: its tip changed during cleanup.`,
      );
    }
    throw new LandError(
      deletion.stderr.trim() || `Cannot delete ${quoted(branch)}.`,
    );
  }
  // This fails when the branch has no configuration, which is fine.
  run(
    context,
    'git',
    ['config', '--remove-section', `branch.${branch}`],
    false,
  );
  context.print(`Deleted branch ${branch} (was ${shortSha(tip)}).`);
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
  keepIfInUse(context, branch, checkout.root);
  if (checkout.current === branch) {
    leaveBranch(context, pr.baseRefName, listWorktrees(context));
  }
  // Check every worktree again, this one included: switching runs user hooks,
  // and other work may have moved onto the branch since land started.
  keepIfInUse(context, branch, null);
  removeBranch(context, branch, tip);
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
  // `git pull` can't refuse to overwrite ignored files, so fetch and merge
  // separately.
  if (
    !(
      runVisibly(context, 'git', ['fetch', '--prune']) &&
      runVisibly(context, 'git', [
        'merge',
        '--ff-only',
        '--no-overwrite-ignore',
        '@{upstream}',
      ])
    )
  ) {
    throw new LandError(
      `Could not fast-forward ${quoted(base)}; update it manually.`,
    );
  }
};

// Finishes a merge land just made. The pull request is merged by now, so a
// problem from here on is only a warning. land doesn't wait for the runs the
// merge starts: an agent that has to act on a deploy watches that run itself.
export const finishMerge = (
  context: LandContext,
  prNumber: number,
  repo: Repository,
  checkout: Checkout,
): void => {
  let pr: PullRequest;
  try {
    pr = viewPr(context, String(prNumber), repo);
  } catch (error) {
    context.warn(
      `PR #${prNumber} is merged, but reading it back failed: ${errorMessage(error)}`,
    );
    return;
  }
  if (pr.state !== 'MERGED') {
    throw new LandError(
      `GitHub accepted PR #${prNumber} but hasn't merged it yet. Run \`standards land ${prNumber}\` again once it has.`,
    );
  }
  const sha = pr.mergeCommit?.oid;
  if (sha) {
    context.print(`PR #${prNumber} is merged as ${shortSha(sha)}.`);
  }
  if (!repo.deleteBranchOnMerge) {
    context.warn(
      'GitHub keeps merged branches in this repository. Enable "Automatically delete head branches" in its settings.',
    );
  }
  try {
    deleteBranch(context, pr, repo, checkout);
    updateBase(context, pr.baseRefName);
  } catch (error) {
    context.warn(
      `PR #${prNumber} is merged, but local cleanup stopped: ${errorMessage(error)}`,
    );
  }
};
