// Waiting until GitHub may merge a pull request's current head and its checks
// have passed. Marks a draft ready and updates a branch that is behind.

import {
  type Check,
  type CheckStates,
  checkStates,
  staleRuns,
} from './land-checks';
import {
  durationText,
  isCommandTimeout,
  type LandContext,
  LandError,
  pollDelay,
  QUIET_SECONDS,
  type Repository,
  run,
  secondsToMs,
  shortSha,
  timestamp,
  viewPr,
} from './land-context';
import { requiredChecks } from './land-required-checks';

const POLL_FIELDS =
  'state,isDraft,headRefOid,baseRefName,mergeStateStatus,statusCheckRollup,updatedAt';

type PolledPr = {
  readonly state: string;
  readonly isDraft: boolean;
  readonly headRefOid: string;
  readonly baseRefName: string;
  readonly mergeStateStatus: string;
  readonly statusCheckRollup: ReadonlyArray<Check> | null;
  readonly updatedAt: string;
};

export type WaitRequest = {
  readonly prNumber: number;
  readonly repo: Repository;
  readonly noWait: boolean;
  readonly hasCi: (head: string, base: string) => boolean;
};

type WaitState = {
  shown: { readonly head: string; readonly waiting: string } | null;
  last: Poll | null;
  readonly again: Map<number, boolean>;
  readonly deadline: number;
};

type Poll = {
  readonly head: string;
  readonly base: string;
  readonly status: string;
  readonly isDraft: boolean;
  readonly quiet: boolean;
  readonly checks: CheckStates;
  // The checks the base branch requires that haven't reported on the head.
  // Only a blocked pull request whose checks have settled looks them up.
  readonly missing: ReadonlyArray<string>;
};

const readPoll = (
  context: LandContext,
  request: WaitRequest,
  state: WaitState,
): Poll => {
  const { prNumber, repo } = request;
  const pr = viewPr<PolledPr>(context, String(prNumber), repo, POLL_FIELDS);
  if (pr.state !== 'OPEN') {
    throw new LandError(
      `PR #${prNumber} became ${pr.state} while land waited.`,
    );
  }
  const head = pr.headRefOid;
  const quiet =
    Date.now() - timestamp(pr.updatedAt) >= secondsToMs(QUIET_SECONDS);
  const rollup = pr.statusCheckRollup ?? [];
  const stale = staleRuns(
    context,
    { prNumber, repo, head },
    rollup,
    state.again,
  );
  const checks = checkStates(rollup, quiet, stale);
  const settledBlocked =
    pr.mergeStateStatus === 'BLOCKED' &&
    !request.noWait &&
    quiet &&
    checks.pending.length === 0 &&
    checks.failed.length === 0;
  const missing = settledBlocked
    ? [...requiredChecks(context, repo, pr.baseRefName)].filter(
        (name) => !checks.passed.includes(name),
      )
    : [];
  return {
    head,
    base: pr.baseRefName,
    status: pr.mergeStateStatus,
    isDraft: pr.isDraft,
    quiet,
    checks,
    missing,
  };
};

// Whether a mergeable pull request may merge now.
const mayMerge = (request: WaitRequest, poll: Poll): boolean => {
  const { passed, pending, stale } = poll.checks;
  const settled = poll.quiet && pending.length === 0;
  // Not even --no-wait merges on a stale skipped check, because no CI ran
  // for it.
  return (
    (request.noWait && stale.length === 0) ||
    (settled && passed.length > 0) ||
    // A pull request without CI has no checks to wait for.
    (pending.length === 0 && !request.hasCi(poll.head, poll.base))
  );
};

// Throws when GitHub blocks the merge for a reason other than checks, which
// waiting can't resolve.
const checkBlocked = (request: WaitRequest, poll: Poll): void => {
  const { checks } = poll;
  const settled =
    poll.quiet && checks.pending.length === 0 && poll.missing.length === 0;
  if (!settled) {
    return;
  }
  const { prNumber } = request;
  const fix = 'Resolve its review threads or get the required review.';
  if (checks.passed.length > 0) {
    throw new LandError(
      `GitHub blocks merging PR #${prNumber} although its checks passed. ${fix}`,
    );
  }
  // With workflows, checks may still appear.
  if (!request.hasCi(poll.head, poll.base)) {
    throw new LandError(
      `GitHub blocks merging PR #${prNumber} for a reason other than checks, because no workflow checks it. ${fix}`,
    );
  }
};

// Acts on one poll and returns whether the head may merge now.
const advance = (
  context: LandContext,
  request: WaitRequest,
  poll: Poll,
): boolean => {
  const { prNumber, repo, noWait } = request;
  const { checks, status } = poll;
  if (checks.failed.length > 0) {
    throw new LandError(
      `Not merging PR #${prNumber}: ${checks.failed.join(', ')} failed on ${shortSha(poll.head)}.`,
    );
  }
  if (status === 'DIRTY') {
    throw new LandError(`PR #${prNumber} has merge conflicts.`);
  }
  if (poll.isDraft) {
    run(context, 'gh', ['pr', 'ready', String(prNumber), '--repo', repo.url]);
  } else if (status === 'BEHIND') {
    // A merge commit keeps the old head in the new one's history.
    run(context, 'gh', [
      'pr',
      'update-branch',
      String(prNumber),
      '--repo',
      repo.url,
    ]);
  } else if (status === 'CLEAN' || status === 'UNSTABLE') {
    return mayMerge(request, poll);
  } else if (status === 'BLOCKED' && noWait) {
    throw new LandError(
      `GitHub requires checks or reviews that PR #${prNumber} still lacks, so --no-wait can't skip them.`,
    );
  } else if (status === 'BLOCKED') {
    checkBlocked(request, poll);
  }
  return false;
};

const waitingFor = (poll: Poll): string => {
  if (poll.checks.pending.length > 0) {
    return poll.checks.pending.join(', ');
  }
  if (!poll.quiet) {
    return 'checks that a recent update may start';
  }
  if (poll.missing.length > 0) {
    return poll.missing.join(', ');
  }
  return poll.checks.passed.length > 0 ? `GitHub (${poll.status})` : 'checks';
};

const timeoutError = (
  context: LandContext,
  prNumber: number,
  { last }: WaitState,
): LandError => {
  const within = `within ${durationText(context.waitMs)}`;
  if (last !== null && waitingFor(last) === 'checks') {
    // --no-wait refuses a blocked pull request.
    const advice =
      last.status === 'BLOCKED'
        ? ''
        : ` If none of the repository's workflows reports on this pull request, run \`standards land ${prNumber} --no-wait\`.`;
    return new LandError(
      `No checks appeared on PR #${prNumber} ${within}.${advice}`,
    );
  }
  const notReady = `PR #${prNumber} wasn't ready to merge ${within}`;
  if (last !== null && last.missing.length > 0) {
    return new LandError(
      `${notReady}: its base branch requires ${last.missing.join(', ')}, which didn't report on ${shortSha(last.head)}.`,
    );
  }
  const stale = last?.checks.stale ?? [];
  if (stale.length > 0) {
    return new LandError(
      `${notReady}: ${stale.join(', ')} ` +
        "skipped while it was a draft and didn't run again after it was marked ready.",
    );
  }
  return new LandError(`${notReady}.`);
};

// Reads one poll and acts on it. A git or gh call that the deadline stopped
// ends the wait like the deadline itself.
const pollOnce = (
  context: LandContext,
  request: WaitRequest,
  state: WaitState,
): { readonly poll: Poll; readonly ready: boolean } => {
  try {
    const poll = readPoll(context, request, state);
    state.last = poll;
    return { poll, ready: advance(context, request, poll) };
  } catch (error) {
    if (isCommandTimeout(error) && Date.now() >= state.deadline) {
      throw timeoutError(context, request.prNumber, state);
    }
    throw error;
  }
};

const pollUntilReady = async (
  context: LandContext,
  request: WaitRequest,
  state: WaitState,
): Promise<string> => {
  if (Date.now() >= state.deadline) {
    throw timeoutError(context, request.prNumber, state);
  }
  const { poll, ready } = pollOnce(context, request, state);
  if (ready) {
    return poll.head;
  }
  const waiting = waitingFor(poll);
  if (state.shown?.head !== poll.head || state.shown.waiting !== waiting) {
    context.print(`Waiting for ${waiting} on ${shortSha(poll.head)}.`);
    state.shown = { head: poll.head, waiting };
  }
  await pollDelay(context);
  return pollUntilReady(context, request, state);
};

// Returns the head commit once GitHub may merge it and its checks have
// passed.
export const waitForChecks = (
  context: LandContext,
  request: WaitRequest,
): Promise<string> =>
  pollUntilReady(context, request, {
    shown: null,
    last: null,
    again: new Map(),
    deadline: context.deadline ?? Date.now() + context.waitMs,
  });
