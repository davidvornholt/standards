// Finishing a fresh merge: clean up locally and wait for the runs the merge
// starts. Problems from here on are warnings, because the pull request is
// merged.

import { type Checkout, deleteBranch, updateBase } from './land-cleanup';
import {
  EXIT_DONE,
  EXIT_MERGED_NOT_GREEN,
  errorMessage,
  GREEN,
  ghJson,
  type LandContext,
  LandError,
  POLL_SECONDS,
  type PullRequest,
  pollDelay,
  polls,
  QUIET_SECONDS,
  type Repository,
  shortSha,
  viewPr,
} from './land-context';

const RUNS_WAIT_MINUTES = 60;
// Push runs appear within seconds, so none after two minutes means none.
const NO_RUNS_MINUTES = 2;

type WorkflowRun = {
  readonly workflowName: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly url: string;
};

type RunsWatch = {
  readonly repo: Repository;
  readonly sha: string;
  readonly queries: ReadonlyArray<ReadonlyArray<string>>;
  green: string | null;
  since: number;
};

const listRuns = (
  context: LandContext,
  watch: RunsWatch,
): ReadonlyArray<WorkflowRun> =>
  watch.queries.flatMap((query) =>
    ghJson<ReadonlyArray<WorkflowRun>>(
      context,
      'run',
      'list',
      '--repo',
      watch.repo.url,
      ...query,
      '--limit',
      '100',
      '--json',
      'workflowName,status,conclusion,url',
    ),
  );

// Decides a poll of completed runs: false when one isn't green, true once
// they have stayed green for a minute, and null to keep waiting.
const judgeCompleted = (
  context: LandContext,
  watch: RunsWatch,
  runs: ReadonlyArray<WorkflowRun>,
  poll: number,
): boolean | null => {
  const red = runs.filter(
    (run) => !GREEN.has((run.conclusion ?? '').toUpperCase()),
  );
  for (const run of red) {
    context.warn(`Push run ${run.workflowName} ${run.conclusion}: ${run.url}`);
  }
  if (red.length > 0) {
    return false;
  }
  // A chained run starts only after the run it follows has completed.
  const green = JSON.stringify(runs);
  if (green !== watch.green) {
    watch.green = green;
    watch.since = poll;
    return null;
  }
  if (poll - watch.since >= QUIET_SECONDS / POLL_SECONDS) {
    context.print('Push runs passed.');
    return true;
  }
  return null;
};

const pollRuns = async (
  context: LandContext,
  watch: RunsWatch,
  poll: number,
): Promise<boolean> => {
  if (poll >= polls(RUNS_WAIT_MINUTES)) {
    context.warn(
      `Push runs on ${shortSha(watch.sha)} are still running after ${RUNS_WAIT_MINUTES} minutes.`,
    );
    return false;
  }
  const runs = listRuns(context, watch);
  if (runs.length === 0 && poll >= polls(NO_RUNS_MINUTES)) {
    context.print('No push runs.');
    return true;
  }
  if (runs.length > 0 && runs.every((run) => run.status === 'completed')) {
    const verdict = judgeCompleted(context, watch, runs, poll);
    if (verdict !== null) {
      return verdict;
    }
  } else {
    watch.green = null;
  }
  await pollDelay(context);
  return pollRuns(context, watch, poll + 1);
};

// Returns whether every run the merge started passed.
const watchPushRuns = (
  context: LandContext,
  repo: Repository,
  hasCi: (sha: string) => boolean,
  pr: { readonly sha: string; readonly mergedAt: string },
): Promise<boolean> => {
  if (!hasCi(pr.sha)) {
    return Promise.resolve(true);
  }
  context.print(
    `Waiting for push runs on ${shortSha(pr.sha)}. The PR is merged, so stopping now changes nothing.`,
  );
  // GitHub files a run chained with `on: workflow_run`, such as a deploy,
  // under the default branch's newest commit when it starts, which is another
  // merge's once one follows. So chained runs are found by time, not commit.
  const queries = [
    ['--commit', pr.sha, '--event', 'push'],
    ['--event', 'workflow_run', '--created', `>=${pr.mergedAt}`],
  ];
  return pollRuns(
    context,
    { repo, sha: pr.sha, queries, green: null, since: 0 },
    0,
  );
};

export type MergedRequest = {
  readonly prNumber: number;
  readonly repo: Repository;
  readonly checkout: Checkout;
  readonly hasCi: (sha: string) => boolean;
};

export const afterMerge = async (
  context: LandContext,
  request: MergedRequest,
): Promise<number> => {
  const { prNumber, repo, checkout, hasCi } = request;
  let pr: PullRequest;
  try {
    pr = viewPr(context, String(prNumber), repo);
  } catch (error) {
    context.warn(
      `PR #${prNumber} is merged, but reading it back failed: ${errorMessage(error)}`,
    );
    return EXIT_MERGED_NOT_GREEN;
  }
  if (pr.state !== 'MERGED') {
    throw new LandError(
      `GitHub accepted PR #${prNumber} but hasn't merged it yet. Run \`standards land ${prNumber}\` again once it has.`,
    );
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
  const sha = pr.mergeCommit?.oid;
  if (!sha) {
    context.warn(
      `PR #${prNumber} is merged, but GitHub shows no merge commit yet, so check its push runs by hand.`,
    );
    return EXIT_MERGED_NOT_GREEN;
  }
  try {
    const green = await watchPushRuns(context, repo, hasCi, {
      sha,
      mergedAt: pr.mergedAt ?? '',
    });
    return green ? EXIT_DONE : EXIT_MERGED_NOT_GREEN;
  } catch (error) {
    context.warn(
      `PR #${prNumber} is merged, but its push runs can't be read: ${errorMessage(error)}`,
    );
    return EXIT_MERGED_NOT_GREEN;
  }
};
