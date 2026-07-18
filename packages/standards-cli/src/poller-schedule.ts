import { hasLabel } from './github-label-identity';
import {
  type IssueItem,
  lastLabelEvent,
  listOpenIssuesWithLabel,
} from './poller-github';
import { createComment, removeLabel } from './poller-github-write';
import type { JobDeps } from './poller-job-shared';
import {
  APPROVED_FOR_FIX,
  APPROVED_FOR_REVIEW,
  FIX_IN_PROGRESS,
  REVIEW_IN_PROGRESS,
} from './poller-protocol';

const MS_PER_SECOND = 1000;
const SECONDS_PER_HOUR = 3600;
const MS_PER_HOUR = SECONDS_PER_HOUR * MS_PER_SECOND;

export type ScheduledJob = {
  readonly deps: JobDeps;
  readonly item: IssueItem;
  readonly approvedAt: string;
};

export const byApprovalAge = (
  left: ScheduledJob,
  right: ScheduledJob,
): number =>
  Date.parse(left.approvedAt) - Date.parse(right.approvedAt) ||
  left.deps.repo.localeCompare(right.deps.repo) ||
  left.item.number - right.item.number;

const sweepStaleClaims = async (
  deps: JobDeps,
  claimLabel: string,
  now: number,
): Promise<ReadonlyArray<string>> => {
  const { config, token, repo } = deps;
  const claimed = await listOpenIssuesWithLabel(token, repo, claimLabel);
  const lines: Array<string> = [];
  for (const item of claimed) {
    // biome-ignore lint/performance/noAwaitInLoops: label removals and comments are GitHub writes; GitHub advises against concurrent write requests (secondary rate limits).
    const event = await lastLabelEvent(token, repo, item.number, claimLabel);
    const ageMs =
      event === null
        ? Number.POSITIVE_INFINITY
        : now - Date.parse(event.createdAt);
    if (ageMs > config.staleClaimHours * MS_PER_HOUR) {
      await removeLabel(token, repo, item.number, claimLabel);
      await createComment(
        token,
        repo,
        item.number,
        `Released a stale \`${claimLabel}\` claim (older than ${config.staleClaimHours}h); the job will retry on a later tick.`,
      );
      lines.push(`${repo}#${item.number}: released stale ${claimLabel}`);
    }
  }
  return lines;
};

const unclaimed = (
  items: ReadonlyArray<IssueItem>,
  claimLabel: string,
): ReadonlyArray<IssueItem> =>
  [...items]
    .filter((item) => !hasLabel(item.labels, claimLabel))
    .sort((left, right) => left.number - right.number);

const schedule = async (
  deps: JobDeps,
  items: ReadonlyArray<IssueItem>,
  approvalLabel: string,
): Promise<ReadonlyArray<ScheduledJob>> => {
  const jobs: Array<ScheduledJob> = [];
  for (const item of items) {
    // biome-ignore lint/performance/noAwaitInLoops: approval times are trust-bearing timeline reads and sequential requests avoid GitHub secondary rate limits.
    const event = await lastLabelEvent(
      deps.token,
      deps.repo,
      item.number,
      approvalLabel,
    );
    jobs.push({ deps, item, approvedAt: event?.createdAt ?? '' });
  }
  return jobs;
};

export const discoverRepositoryJobs = async (
  deps: JobDeps,
  now: number,
): Promise<{
  readonly lines: ReadonlyArray<string>;
  readonly reviews: ReadonlyArray<ScheduledJob>;
  readonly fixes: ReadonlyArray<ScheduledJob>;
}> => {
  const { token, repo } = deps;
  const lines: Array<string> = [];
  for (const claimLabel of [FIX_IN_PROGRESS, REVIEW_IN_PROGRESS]) {
    // biome-ignore lint/performance/noAwaitInLoops: sweeps issue GitHub writes; GitHub advises against concurrent write requests (secondary rate limits).
    lines.push(...(await sweepStaleClaims(deps, claimLabel, now)));
  }
  const reviewItems = unclaimed(
    (await listOpenIssuesWithLabel(token, repo, APPROVED_FOR_REVIEW)).filter(
      (item) => item.isPullRequest,
    ),
    REVIEW_IN_PROGRESS,
  );
  const fixItems = unclaimed(
    (await listOpenIssuesWithLabel(token, repo, APPROVED_FOR_FIX)).filter(
      (item) => !item.isPullRequest,
    ),
    FIX_IN_PROGRESS,
  );
  return {
    lines,
    reviews: await schedule(deps, reviewItems, APPROVED_FOR_REVIEW),
    fixes: await schedule(deps, fixItems, APPROVED_FOR_FIX),
  };
};
