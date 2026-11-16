// The workflow runs on a pull request's head that haven't finished. Rerunning
// a run's failed jobs drops their failed checks from the pull request at once,
// and the new attempt shows its checks only seconds later, without changing
// the pull request's update time. A run waiting in a concurrency group shows
// no checks either. So checks that look settled can still be missing some.
// The checks are read before the runs, so a run that finished in between may
// have reported checks they lack. A run that finished less than QUIET_SECONDS
// ago counts as unsettled too, and a later poll reads the checks again.

import {
  type LandContext,
  QUIET_SECONDS,
  type Repository,
  run,
  secondsToMs,
  timestamp,
} from './land-context';

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
  readonly updated_at?: string;
  // biome-ignore lint/style/useNamingConvention: GitHub's REST field.
  readonly head_branch?: string;
};

// The names of the unsettled runs, such as "Standards".
export const unsettledRuns = (
  context: LandContext,
  repo: Repository,
  head: { readonly sha: string; readonly branch: string },
): ReadonlyArray<string> => {
  const lines = run(context, 'gh', [
    'api',
    `repos/${repo.nameWithOwner}/actions/runs?head_sha=${head.sha}&exclude_pull_requests=true&per_page=${RUNS_PER_PAGE}`,
    '--paginate',
    '--jq',
    '.workflow_runs[] | {name, event, status, head_branch, updated_at} | tojson',
  ])
    .stdout.split('\n')
    .filter(Boolean);
  const settledBefore = Date.now() - secondsToMs(QUIET_SECONDS);
  const names = lines
    .map((line) => JSON.parse(line) as WorkflowRun)
    .filter(
      (workflowRun) =>
        (workflowRun.status !== 'completed' ||
          timestamp(workflowRun.updated_at) > settledBefore) &&
        PR_EVENTS.has(workflowRun.event ?? '') &&
        workflowRun.head_branch === head.branch,
    )
    .map((workflowRun) => workflowRun.name || 'unnamed workflow');
  return [...new Set(names)];
};
