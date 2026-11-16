// The workflow runs on a pull request's head that haven't finished. Rerunning
// a run's failed jobs drops their failed checks from the pull request at once,
// and the new attempt shows its checks only seconds later, without changing
// the pull request's update time. A run waiting in a concurrency group shows
// no checks either. So checks that look settled can still be missing some.

import { type LandContext, type Repository, run } from './land-context';

// Runs on the head that report checks on the pull request, as in
// land-workflows.ts.
const PR_EVENTS: ReadonlySet<string> = new Set([
  'pull_request',
  'pull_request_target',
  'push',
]);
const RUNS_PER_PAGE = 100;

type WorkflowRun = {
  readonly name?: string;
  readonly event?: string;
  readonly status?: string;
  // biome-ignore lint/style/useNamingConvention: GitHub's REST field.
  readonly head_branch?: string;
};

// The names of the unfinished runs, such as "Standards".
export const unfinishedRuns = (
  context: LandContext,
  repo: Repository,
  head: { readonly sha: string; readonly branch: string },
): ReadonlyArray<string> => {
  const lines = run(context, 'gh', [
    'api',
    `repos/${repo.nameWithOwner}/actions/runs?head_sha=${head.sha}&exclude_pull_requests=true&per_page=${RUNS_PER_PAGE}`,
    '--paginate',
    '--jq',
    '.workflow_runs[] | {name, event, status, head_branch} | tojson',
  ])
    .stdout.split('\n')
    .filter(Boolean);
  const names = lines
    .map((line) => JSON.parse(line) as WorkflowRun)
    .filter(
      (workflowRun) =>
        workflowRun.status !== 'completed' &&
        PR_EVENTS.has(workflowRun.event ?? '') &&
        workflowRun.head_branch === head.branch,
    )
    .map((workflowRun) => workflowRun.name || 'unnamed workflow');
  return [...new Set(names)];
};

// The runs the last lookup found unfinished on a head.
export type SeenRuns = {
  readonly head: string;
  readonly names: ReadonlyArray<string>;
} | null;

// The runs to wait for, and what to remember for the next lookup. The checks
// were read before the runs, so a run that finished in between may have
// reported checks they lack. A run counts as pending for one more poll after
// it finishes, which reads the checks again.
export const pendingRuns = (
  context: LandContext,
  repo: Repository,
  head: { readonly sha: string; readonly branch: string },
  seen: SeenRuns,
): { readonly pending: ReadonlyArray<string>; readonly seen: SeenRuns } => {
  const running = unfinishedRuns(context, repo, head);
  const finished =
    seen?.head === head.sha
      ? seen.names.filter((name) => !running.includes(name))
      : [];
  return {
    pending: [...running, ...finished],
    seen: running.length > 0 ? { head: head.sha, names: running } : null,
  };
};
