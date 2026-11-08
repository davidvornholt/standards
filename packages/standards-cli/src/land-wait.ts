// Waiting until GitHub may merge a pull request's current head and its checks
// have passed. Marks a draft ready and updates a branch that is behind.

import {
  type Check,
  type CheckStates,
  checkStates,
  staleRuns,
} from './land-checks';
import {
  type LandContext,
  LandError,
  pollDelay,
  polls,
  QUIET_SECONDS,
  type Repository,
  run,
  secondsToMs,
  shortSha,
  timestamp,
  viewPr,
} from './land-context';

const WAIT_MINUTES = 45;
const POLL_FIELDS =
  'state,isDraft,headRefOid,mergeStateStatus,statusCheckRollup,updatedAt';

type PolledPr = {
  readonly state: string;
  readonly isDraft: boolean;
  readonly headRefOid: string;
  readonly mergeStateStatus: string;
  readonly statusCheckRollup: ReadonlyArray<Check> | null;
  readonly updatedAt: string;
};

export type WaitRequest = {
  readonly prNumber: number;
  readonly repo: Repository;
  readonly noWait: boolean;
  readonly hasCi: (sha: string) => boolean;
};

type WaitState = {
  shown: { readonly head: string; readonly waiting: string } | null;
  checks: CheckStates | null;
  readonly again: Map<number, boolean>;
};

type Poll = {
  readonly head: string;
  readonly status: string;
  readonly isDraft: boolean;
  readonly quiet: boolean;
  readonly checks: CheckStates;
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
  return {
    head,
    status: pr.mergeStateStatus,
    isDraft: pr.isDraft,
    quiet,
    checks: checkStates(rollup, quiet, stale),
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
    // A head without CI has no checks to wait for.
    (pending.length === 0 && !request.hasCi(poll.head))
  );
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
  const settledAndPassed =
    poll.quiet && checks.pending.length === 0 && checks.passed.length > 0;
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
  } else if (status === 'BLOCKED' && settledAndPassed) {
    throw new LandError(
      `GitHub blocks merging PR #${prNumber} although its checks passed. Resolve its review threads or get the required review.`,
    );
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
  return poll.checks.passed.length > 0 ? `GitHub (${poll.status})` : 'checks';
};

const timeoutError = (prNumber: number, state: WaitState): LandError => {
  if (state.shown?.waiting === 'checks') {
    return new LandError(
      `No checks appeared on PR #${prNumber} within ${WAIT_MINUTES} minutes. ` +
        `If none of the repository's workflows reports on this pull request, run \`standards land ${prNumber} --no-wait\`.`,
    );
  }
  const stale = state.checks?.stale ?? [];
  if (stale.length > 0) {
    return new LandError(
      `PR #${prNumber} wasn't ready to merge within ${WAIT_MINUTES} minutes: ${stale.join(', ')} ` +
        "skipped while it was a draft and didn't run again after it was marked ready.",
    );
  }
  return new LandError(
    `PR #${prNumber} wasn't ready to merge within ${WAIT_MINUTES} minutes.`,
  );
};

const pollUntilReady = async (
  context: LandContext,
  request: WaitRequest,
  state: WaitState,
  attempt: number,
): Promise<string> => {
  if (attempt >= polls(WAIT_MINUTES)) {
    throw timeoutError(request.prNumber, state);
  }
  const poll = readPoll(context, request, state);
  state.checks = poll.checks;
  if (advance(context, request, poll)) {
    return poll.head;
  }
  const waiting = waitingFor(poll);
  if (state.shown?.head !== poll.head || state.shown.waiting !== waiting) {
    context.print(`Waiting for ${waiting} on ${shortSha(poll.head)}.`);
    state.shown = { head: poll.head, waiting };
  }
  await pollDelay(context);
  return pollUntilReady(context, request, state, attempt + 1);
};

// Returns the head commit once GitHub may merge it and its checks have
// passed.
export const waitForChecks = (
  context: LandContext,
  request: WaitRequest,
): Promise<string> =>
  pollUntilReady(
    context,
    request,
    { shown: null, checks: null, again: new Map() },
    0,
  );
