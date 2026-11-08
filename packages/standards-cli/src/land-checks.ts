// Sorting a pull request's checks into passed, pending, and failed ones, and
// recognizing checks that a draft skipped and its ready event replaces.

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
  readonly completedAt?: string;
};

export type CheckStates = {
  readonly passed: Array<string>;
  readonly pending: Array<string>;
  readonly stale: Array<string>;
  readonly failed: Array<string>;
};

const READY_QUERY =
  'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) ' +
  '{ pullRequest(number: $number) { timelineItems(itemTypes: READY_FOR_REVIEW_EVENT, last: 1) ' +
  '{ nodes { ... on ReadyForReviewEvent { createdAt } } } } } }';

const RUNS_QUERY =
  'query($owner: String!, $name: String!, $head: GitObjectID!, $tree: String!) ' +
  '{ repository(owner: $owner, name: $name) { commit: object(oid: $head) { ... on Commit ' +
  '{ checkSuites(first: 100) { nodes { workflowRun { databaseId file { path } } } } } } ' +
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

// Maps each workflow run on a head to whether its workflow runs again when a
// draft is marked ready.
const runsAgainWhenReady = (
  context: LandContext,
  repo: Repository,
  head: string,
): Map<number, boolean> => {
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
  const again = new Map<number, boolean>();
  for (const { workflowRun } of commit.checkSuites.nodes) {
    if (workflowRun) {
      const text = texts.get(workflowRun.file?.path ?? '') ?? '';
      again.set(workflowRun.databaseId, READY_EVENT_PATTERN.test(text));
    }
  }
  return again;
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
    for (const [id, runsAgain] of runsAgainWhenReady(context, repo, head)) {
      again.set(id, runsAgain);
    }
  }
  // A workflow that doesn't run on the ready event, such as one that only
  // auto-merges, never replaces its skipped checks, so their skip is final.
  return new Set([...early].filter((id) => again.get(id) === true));
};

type CheckRunState = 'passed' | 'pending' | 'stale' | 'failed' | 'superseded';

const checkRunState = (
  check: Check,
  newest: ReadonlyMap<string, number>,
  quiet: boolean,
  staleIds: ReadonlySet<number>,
): CheckRunState => {
  const id = runIdOf(check.detailsUrl);
  const superseded = id < (newest.get(check.workflowName ?? '') ?? 0);
  // CI that skips its jobs on drafts leaves skipped checks that GitHub
  // counts as passed, although nothing ran. The ready event starts the run
  // that replaces them.
  const stale = check.conclusion === 'SKIPPED' && staleIds.has(id);
  // A running check's conclusion is empty, so its status decides first.
  if (check.status !== 'COMPLETED') {
    return 'pending';
  }
  if (superseded && (stale || check.conclusion === 'CANCELLED')) {
    return 'superseded';
  }
  if (stale) {
    return 'stale';
  }
  if (GREEN.has(check.conclusion ?? '')) {
    return 'passed';
  }
  return check.conclusion === 'CANCELLED' && !quiet ? 'pending' : 'failed';
};

const STATUS_CONTEXT_STATES: ReadonlyMap<string, 'passed' | 'pending'> =
  new Map([
    ['SUCCESS', 'passed'],
    ['PENDING', 'pending'],
    ['EXPECTED', 'pending'],
  ]);

// Sorts a pull request's checks into passed, pending, and failed names, and
// lists the stale ones among the pending.
export const checkStates = (
  rollup: ReadonlyArray<Check>,
  quiet: boolean,
  staleIds: ReadonlySet<number>,
): CheckStates => {
  // Several workflow runs can report checks for one head. A run that a newer
  // run of its workflow cancelled is superseded, so its checks don't count.
  // Until the pull request is quiet, that newer run may not show yet.
  const newest = new Map<string, number>();
  for (const check of rollup) {
    if (check.workflowName) {
      newest.set(
        check.workflowName,
        Math.max(
          newest.get(check.workflowName) ?? 0,
          runIdOf(check.detailsUrl),
        ),
      );
    }
  }
  const states: CheckStates = {
    passed: [],
    pending: [],
    stale: [],
    failed: [],
  };
  for (const check of rollup) {
    const name = check.name || check.context || 'unnamed check';
    const state =
      check.__typename === 'CheckRun'
        ? checkRunState(check, newest, quiet, staleIds)
        : (STATUS_CONTEXT_STATES.get(check.state ?? '') ?? 'failed');
    if (state === 'stale') {
      states.stale.push(name);
      states.pending.push(name);
    } else if (state !== 'superseded') {
      states[state].push(name);
    }
  }
  return states;
};
