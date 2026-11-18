// Sorting a pull request's checks into passed, pending, and failed ones. A
// check that a later run of its workflow replaced doesn't count.

import {
  type Check,
  type CheckStates,
  hasResult,
  isFailure,
} from './land-checks';
import { GREEN, runIdOf } from './land-context';

type CheckRunState =
  | 'passed'
  | 'pending'
  | 'stale'
  | 'unresolved'
  | 'failed'
  | 'superseded';

type Rules = {
  readonly workflows: ReadonlyMap<number, string>;
  // The newest run of each workflow name.
  readonly newest: ReadonlyMap<string, number>;
  // The runs of each workflow that have a check still running, keyed by
  // workflowKey.
  readonly active: ReadonlyMap<string, ReadonlySet<number>>;
  // When each run's latest check of a workflow and name that finished with a
  // result started, by run, keyed by resultKey. A skipped or cancelled check
  // has none.
  readonly finished: ReadonlyMap<string, ReadonlyMap<number, number>>;
  readonly quiet: boolean;
  readonly staleIds: ReadonlySet<number>;
};

// A run's workflow file and event, or its workflow's name when they aren't
// known. Empty for a check that no workflow reports.
const workflowKey = (
  check: Check,
  workflows: ReadonlyMap<number, string>,
): string => {
  if (!check.workflowName) {
    return '';
  }
  const started = workflows.get(runIdOf(check.detailsUrl));
  return started ? `run:${started}` : `name:${check.workflowName}`;
};

// The key under which checks replace each other's results, or null when
// the run's workflow file and event aren't known.
const resultKey = (
  check: Check,
  workflows: ReadonlyMap<number, string>,
): string | null => {
  const started = workflows.get(runIdOf(check.detailsUrl));
  return started && check.workflowName
    ? `${started}\n${check.name ?? ''}`
    : null;
};

// When a check started, or NaN while it hasn't.
const startTime = (check: Check): number => Date.parse(check.startedAt ?? '');

const raiseTo = (map: Map<string, number>, key: string, id: number): void => {
  map.set(key, Math.max(map.get(key) ?? Number.NEGATIVE_INFINITY, id));
};

const rulesFor = (
  rollup: ReadonlyArray<Check>,
  { workflows, quiet, staleIds }: CheckOptions,
): Rules => {
  const newest = new Map<string, number>();
  const active = new Map<string, Set<number>>();
  const finished = new Map<string, Map<number, number>>();
  for (const check of rollup) {
    const workflow = workflowKey(check, workflows);
    const result = resultKey(check, workflows);
    const id = runIdOf(check.detailsUrl);
    if (check.workflowName) {
      raiseTo(newest, check.workflowName, id);
    }
    if (workflow && check.status !== 'COMPLETED') {
      active.set(workflow, (active.get(workflow) ?? new Set()).add(id));
    } else if (result && hasResult(check) && !Number.isNaN(startTime(check))) {
      const starts = finished.get(result) ?? new Map<number, number>();
      starts.set(
        id,
        Math.max(starts.get(id) ?? Number.NEGATIVE_INFINITY, startTime(check)),
      );
      finished.set(result, starts);
    }
  }
  return { workflows, newest, active, finished, quiet, staleIds };
};

// The state of a completed check that neither passed nor was superseded.
const unpassedState = (check: Check, rules: Rules): CheckRunState => {
  if (check.conclusion === 'CANCELLED') {
    return rules.quiet ? 'failed' : 'pending';
  }
  // Another run of the workflow that is still running may replace the
  // failure, even before it reports the check.
  const id = runIdOf(check.detailsUrl);
  const running = rules.active.get(workflowKey(check, rules.workflows)) ?? [];
  return [...running].some((other) => other !== id) ? 'unresolved' : 'failed';
};

// Whether a failed check has a later result: another run's check of the same
// workflow file, event, and name that started later and finished with a
// result. That result counts instead, as GitHub counts the latest check of a
// name, such as the passing replacement of a check that failed because its
// run was cancelled. A job of the failure's own run replaces nothing, and
// other checks keep the rules of checkRunState.
const isReplaced = (check: Check, rules: Rules): boolean => {
  const key = resultKey(check, rules.workflows);
  const starts = key === null ? undefined : rules.finished.get(key);
  const id = runIdOf(check.detailsUrl);
  return (
    isFailure(check) &&
    [...(starts ?? [])].some(
      ([other, started]) => other !== id && started > startTime(check),
    )
  );
};

const checkRunState = (check: Check, rules: Rules): CheckRunState => {
  const id = runIdOf(check.detailsUrl);
  const superseded = id < (rules.newest.get(check.workflowName ?? '') ?? 0);
  // CI that skips its jobs on drafts leaves skipped checks that GitHub
  // counts as passed, although nothing ran. The ready event starts the run
  // that replaces them.
  const stale = check.conclusion === 'SKIPPED' && rules.staleIds.has(id);
  // A running check's conclusion is empty, so its status decides first.
  if (check.status !== 'COMPLETED') {
    return 'pending';
  }
  if (
    isReplaced(check, rules) ||
    (superseded && (stale || check.conclusion === 'CANCELLED'))
  ) {
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
  readonly workflows: ReadonlyMap<number, string>;
};

// Sorts a pull request's checks into passed, pending, and failed names, and
// lists the stale and unresolved ones among the pending.
export const checkStates = (
  rollup: ReadonlyArray<Check>,
  options: CheckOptions,
): CheckStates => {
  // Several workflow runs can report checks for one head. A run that a newer
  // run of its workflow cancelled is superseded, so its checks don't count.
  // Until the pull request is quiet, that newer run may not show yet.
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
