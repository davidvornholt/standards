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

type HeadRun = { readonly file: string; readonly runsAgain: boolean };

// Maps each workflow run on a head to its workflow file and whether that
// workflow runs again when a draft is marked ready.
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

const isFailure = (check: Check): boolean =>
  check.status === 'COMPLETED' &&
  check.conclusion !== 'CANCELLED' &&
  !GREEN.has(check.conclusion ?? '');

// Whether a completed check ran to a result. A skipped or cancelled one
// didn't.
const hasResult = (check: Check): boolean =>
  check.conclusion !== 'SKIPPED' && check.conclusion !== 'CANCELLED';

// The workflow file of each run on the head, when a failed check has a newer
// run of a workflow with the same name. Two workflow files can share a name,
// and a run of one never replaces the other's checks. The map covers every
// workflow run in the rollup or is empty, in which case names identify
// workflows. `cache` keeps the files across polls.
export const workflowFiles = (
  context: LandContext,
  { repo, head }: PolledHead,
  rollup: ReadonlyArray<Check>,
  cache: Map<number, string>,
): ReadonlyMap<number, string> => {
  const runs = rollup.filter((check) => check.workflowName);
  const newest = new Map<string, number>();
  for (const check of runs) {
    raiseTo(newest, check.workflowName ?? '', runIdOf(check.detailsUrl));
  }
  const contested = runs.some(
    (check) =>
      isFailure(check) &&
      runIdOf(check.detailsUrl) < (newest.get(check.workflowName ?? '') ?? 0),
  );
  if (!contested) {
    return new Map();
  }
  const ids = runs.map((check) => runIdOf(check.detailsUrl));
  if (ids.some((id) => !cache.has(id))) {
    for (const [id, { file }] of readHeadRuns(context, repo, head)) {
      cache.set(id, file);
    }
  }
  return ids.every((id) => cache.has(id)) ? cache : new Map();
};

type CheckRunState =
  | 'passed'
  | 'pending'
  | 'stale'
  | 'unresolved'
  | 'failed'
  | 'superseded';

type Rules = {
  readonly files: ReadonlyMap<number, string>;
  // The newest run of each workflow.
  readonly newest: ReadonlyMap<string, number>;
  // The newest run of each workflow that has a check still running.
  readonly active: ReadonlyMap<string, number>;
  // The newest run of each workflow whose check of a name finished with a
  // result, keyed by checkKey. A skipped or cancelled check has none.
  readonly finished: ReadonlyMap<string, number>;
  readonly quiet: boolean;
  readonly staleIds: ReadonlySet<number>;
};

// A workflow file, or the workflow's name when the files aren't known. Empty
// for a check that no workflow reports.
const workflowKey = (
  check: Check,
  files: ReadonlyMap<number, string>,
): string => {
  if (!check.workflowName) {
    return '';
  }
  const file = files.get(runIdOf(check.detailsUrl));
  return file ? `file:${file}` : `name:${check.workflowName}`;
};

const checkKey = (check: Check, files: ReadonlyMap<number, string>): string =>
  `${workflowKey(check, files)}\n${check.name ?? ''}`;

const raiseTo = (map: Map<string, number>, key: string, id: number): void => {
  map.set(key, Math.max(map.get(key) ?? 0, id));
};

const rulesFor = (
  rollup: ReadonlyArray<Check>,
  { files, quiet, staleIds }: CheckOptions,
): Rules => {
  const newest = new Map<string, number>();
  const active = new Map<string, number>();
  const finished = new Map<string, number>();
  for (const check of rollup) {
    const workflow = workflowKey(check, files);
    if (workflow) {
      const id = runIdOf(check.detailsUrl);
      raiseTo(newest, workflow, id);
      if (check.status !== 'COMPLETED') {
        raiseTo(active, workflow, id);
      } else if (hasResult(check)) {
        raiseTo(finished, checkKey(check, files), id);
      }
    }
  }
  return { files, newest, active, finished, quiet, staleIds };
};

// The state of a completed check that neither passed nor was superseded.
const unpassedState = (check: Check, rules: Rules): CheckRunState => {
  if (check.conclusion === 'CANCELLED') {
    return rules.quiet ? 'failed' : 'pending';
  }
  // A newer run of the workflow that is still running may replace the
  // failure, even before it reports the check.
  const workflow = workflowKey(check, rules.files);
  return runIdOf(check.detailsUrl) < (rules.active.get(workflow) ?? 0)
    ? 'unresolved'
    : 'failed';
};

const checkRunState = (check: Check, rules: Rules): CheckRunState => {
  const id = runIdOf(check.detailsUrl);
  const workflow = workflowKey(check, rules.files);
  const superseded = id < (rules.newest.get(workflow) ?? 0);
  // A newer run's result for the check counts instead, such as the passing
  // replacement of a check that failed because its run was cancelled.
  const replaced = id < (rules.finished.get(checkKey(check, rules.files)) ?? 0);
  // CI that skips its jobs on drafts leaves skipped checks that GitHub
  // counts as passed, although nothing ran. The ready event starts the run
  // that replaces them.
  const stale = check.conclusion === 'SKIPPED' && rules.staleIds.has(id);
  // A running check's conclusion is empty, so its status decides first.
  if (check.status !== 'COMPLETED') {
    return 'pending';
  }
  if (replaced || (superseded && (stale || check.conclusion === 'CANCELLED'))) {
    return 'superseded';
  }
  if (stale) {
    return 'stale';
  }
  return GREEN.has(check.conclusion ?? '')
    ? 'passed'
    : unpassedState(check, rules);
};

const STATUS_CONTEXT_STATES: ReadonlyMap<string, 'passed' | 'pending'> =
  new Map([
    ['SUCCESS', 'passed'],
    ['PENDING', 'pending'],
    ['EXPECTED', 'pending'],
  ]);

export type CheckOptions = {
  readonly quiet: boolean;
  readonly staleIds: ReadonlySet<number>;
  readonly files: ReadonlyMap<number, string>;
};

// Sorts a pull request's checks into passed, pending, and failed names, and
// lists the stale and unresolved ones among the pending.
export const checkStates = (
  rollup: ReadonlyArray<Check>,
  options: CheckOptions,
): CheckStates => {
  // Several workflow runs can report checks for one head. A run that a newer
  // run of its workflow cancelled is superseded, so its checks don't count,
  // and neither does a check that a newer run finished again. Until the pull
  // request is quiet, that newer run may not show yet.
  const rules = rulesFor(rollup, options);
  const states: CheckStates = {
    passed: [],
    pending: [],
    stale: [],
    unresolved: [],
    failed: [],
  };
  for (const check of rollup) {
    const name = check.name || check.context || 'unnamed check';
    const state =
      check.__typename === 'CheckRun'
        ? checkRunState(check, rules)
        : (STATUS_CONTEXT_STATES.get(check.state ?? '') ?? 'failed');
    if (state === 'stale' || state === 'unresolved') {
      states[state].push(name);
      states.pending.push(name);
    } else if (state !== 'superseded') {
      states[state].push(name);
    }
  }
  return states;
};
