// Reading the workflow runs on a pull request's head: which checks a draft
// skipped and its ready event replaces, and what started each run.

import {
  GREEN,
  type LandContext,
  ownerAndName,
  type Repository,
  run,
  runIdOf,
  timestamp,
} from './land-context';

export type Check = {
  readonly __typename?: string;
  readonly name?: string;
  readonly context?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly state?: string;
  readonly workflowName?: string;
  readonly detailsUrl?: string;
  readonly startedAt?: string | null;
  readonly completedAt?: string;
};

export type CheckStates = {
  readonly passed: Array<string>;
  readonly pending: Array<string>;
  readonly stale: Array<string>;
  // Failed checks that a newer, still running run of their workflow may
  // replace. They count as pending, but --no-wait can't skip them.
  readonly unresolved: Array<string>;
  readonly failed: Array<string>;
};

const READY_QUERY =
  'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) ' +
  '{ pullRequest(number: $number) { timelineItems(itemTypes: READY_FOR_REVIEW_EVENT, last: 1) ' +
  '{ nodes { ... on ReadyForReviewEvent { createdAt } } } } } }';

const RUNS_QUERY =
  'query($owner: String!, $name: String!, $head: GitObjectID!, $tree: String!) ' +
  '{ repository(owner: $owner, name: $name) { commit: object(oid: $head) { ... on Commit ' +
  '{ checkSuites(first: 100) { nodes { workflowRun { databaseId event file { path } } } } } } ' +
  'workflows: object(expression: $tree) { ... on Tree { entries { path object { ... on Blob { text } } } } } } }';

// Finding the event type outside a comment stands in for parsing the YAML.
const READY_EVENT_PATTERN = /^[^#\n]*\bready_for_review\b/mu;

// When the pull request was last marked ready for review, or null if it never
// was a draft.
const readyTime = (
  context: LandContext,
  prNumber: number,
  repo: Repository,
): number | null => {
  const { owner, name } = ownerAndName(repo);
  const ready = run(context, 'gh', [
    'api',
    'graphql',
    '-F',
    `number=${prNumber}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `name=${name}`,
    '-f',
    `query=${READY_QUERY}`,
    '--jq',
    '.data.repository.pullRequest.timelineItems.nodes[0].createdAt // empty',
  ]).stdout.trim();
  return ready ? timestamp(ready) : null;
};

type RunsResponse = {
  readonly data: {
    readonly repository: {
      readonly commit: {
        readonly checkSuites: {
          readonly nodes: ReadonlyArray<{
            readonly workflowRun: {
              readonly databaseId: number;
              readonly event?: string;
              readonly file: { readonly path?: string } | null;
            } | null;
          }>;
        };
      };
      readonly workflows: {
        readonly entries?: ReadonlyArray<{
          readonly path: string;
          readonly object: { readonly text?: string | null } | null;
        }>;
      } | null;
    };
  };
};

type HeadRun = {
  readonly file: string;
  readonly event: string;
  readonly runsAgain: boolean;
};

// Maps each workflow run on a head to its workflow file, the event that
// started it, and whether that workflow runs again when a draft is marked
// ready.
const readHeadRuns = (
  context: LandContext,
  repo: Repository,
  head: string,
): Map<number, HeadRun> => {
  const { owner, name } = ownerAndName(repo);
  const response = JSON.parse(
    run(context, 'gh', [
      'api',
      'graphql',
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-f',
      `head=${head}`,
      '-f',
      `tree=${head}:.github/workflows`,
      '-f',
      `query=${RUNS_QUERY}`,
    ]).stdout,
  ) as RunsResponse;
  const { commit, workflows } = response.data.repository;
  const texts = new Map(
    (workflows?.entries ?? []).map((entry) => [
      entry.path,
      entry.object?.text ?? '',
    ]),
  );
  const runs = new Map<number, HeadRun>();
  for (const { workflowRun } of commit.checkSuites.nodes) {
    if (workflowRun) {
      const file = workflowRun.file?.path ?? '';
      runs.set(workflowRun.databaseId, {
        file,
        event: workflowRun.event ?? '',
        runsAgain: READY_EVENT_PATTERN.test(texts.get(file) ?? ''),
      });
    }
  }
  return runs;
};

export type PolledHead = {
  readonly prNumber: number;
  readonly repo: Repository;
  readonly head: string;
};

// The runs whose checks were skipped while the pull request was a draft and
// that the ready event replaces. `again` caches runsAgainWhenReady across
// polls.
export const staleRuns = (
  context: LandContext,
  { prNumber, repo, head }: PolledHead,
  rollup: ReadonlyArray<Check>,
  again: Map<number, boolean>,
): Set<number> => {
  // Only skipped checks need the ready time, so most polls skip the query.
  const skipped = rollup.filter((check) => check.conclusion === 'SKIPPED');
  const ready = skipped.length > 0 ? readyTime(context, prNumber, repo) : null;
  const early = new Set(
    ready === null
      ? []
      : skipped
          .filter((check) => timestamp(check.completedAt) < ready)
          .map((check) => runIdOf(check.detailsUrl)),
  );
  if ([...early].some((id) => !again.has(id))) {
    for (const id of early) {
      again.set(id, false);
    }
    for (const [id, { runsAgain }] of readHeadRuns(context, repo, head)) {
      again.set(id, runsAgain);
    }
  }
  // A workflow that doesn't run on the ready event, such as one that only
  // auto-merges, never replaces its skipped checks, so their skip is final.
  return new Set([...early].filter((id) => again.get(id) === true));
};

// Whether a completed check ran to a result. A skipped or cancelled one
// didn't.
export const hasResult = (check: Check): boolean =>
  check.conclusion !== 'SKIPPED' && check.conclusion !== 'CANCELLED';

export const isFailure = (check: Check): boolean =>
  check.status === 'COMPLETED' &&
  check.conclusion !== 'CANCELLED' &&
  !GREEN.has(check.conclusion ?? '');

// Whether a failed check shares its workflow's name with another run that is
// still running or has a result, which could replace it.
const isContested = (runs: ReadonlyArray<Check>): boolean => {
  const rivals = new Map<string, Set<number>>();
  for (const check of runs) {
    if (check.status !== 'COMPLETED' || hasResult(check)) {
      const ids = rivals.get(check.workflowName ?? '') ?? new Set();
      rivals.set(check.workflowName ?? '', ids.add(runIdOf(check.detailsUrl)));
    }
  }
  return runs.some(
    (check) =>
      isFailure(check) &&
      [...(rivals.get(check.workflowName ?? '') ?? [])].some(
        (id) => id !== runIdOf(check.detailsUrl),
      ),
  );
};

// What started each workflow run on the head, as its workflow file and event,
// when a failure is contested. Only a later result of the same file and event
// replaces a failure: two workflow files can share a name, and a push run
// doesn't test the merge result that a pull_request run tests. The map covers
// every workflow run in the rollup or is empty, in which case no failure is
// replaced. `cache` keeps the runs across polls.
export const workflowRuns = (
  context: LandContext,
  { repo, head }: PolledHead,
  rollup: ReadonlyArray<Check>,
  cache: Map<number, string>,
): ReadonlyMap<number, string> => {
  const runs = rollup.filter((check) => check.workflowName);
  if (!isContested(runs)) {
    return new Map();
  }
  const ids = runs.map((check) => runIdOf(check.detailsUrl));
  if (ids.some((id) => !cache.has(id))) {
    for (const [id, { file, event }] of readHeadRuns(context, repo, head)) {
      if (file && event) {
        cache.set(id, `${file} on ${event}`);
      }
    }
  }
  return ids.every((id) => cache.has(id)) ? cache : new Map();
};
