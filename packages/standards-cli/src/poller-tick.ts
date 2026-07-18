// One poller tick: sweep stale claims, then run approved jobs oldest-first —
// review jobs before fix jobs, because reviews unblock merges — under the
// per-tick Codex run cap. All state lives in GitHub, so a tick is re-runnable
// and a crash costs at most one stale claim that the next tick sweeps.

import type { PollerConfig } from './poller-config';
import { runFixJob } from './poller-fix-run';
import {
  type IssueItem,
  lastLabelEvent,
  listOpenIssuesWithLabel,
  repoDefaultBranch,
} from './poller-github';
import { createComment, removeLabel } from './poller-github-write';
import type { JobDeps, JobResult } from './poller-job-shared';
import {
  APPROVED_FOR_FIX,
  FIX_IN_PROGRESS,
  REVIEW_APPROVED,
  REVIEW_IN_PROGRESS,
} from './poller-protocol';
import { runReviewJob } from './poller-review-run';
import type { RoleCache } from './poller-trust';

const MS_PER_SECOND = 1000;
const SECONDS_PER_HOUR = 3600;
const MS_PER_HOUR = SECONDS_PER_HOUR * MS_PER_SECOND;

export type TickReport = {
  readonly lines: ReadonlyArray<string>;
  readonly problems: ReadonlyArray<string>;
};

type SweepOptions = {
  readonly token: string | null;
  readonly repo: string;
  readonly claimLabel: string;
  readonly staleClaimHours: number;
  readonly now: number;
};

// Release claims whose label event is older than the stale window. The claim
// holder is gone (crashed run or dead host); the approval label survives, so
// the job simply retries on a later tick.
const sweepStaleClaims = async (
  options: SweepOptions,
): Promise<ReadonlyArray<string>> => {
  const { token, repo, claimLabel } = options;
  const claimed = await listOpenIssuesWithLabel(token, repo, claimLabel);
  const lines: Array<string> = [];
  for (const item of claimed) {
    // biome-ignore lint/performance/noAwaitInLoops: label removals and comments are GitHub writes; GitHub advises against concurrent write requests (secondary rate limits).
    const event = await lastLabelEvent(token, repo, item.number, claimLabel);
    const ageMs =
      event === null
        ? Number.POSITIVE_INFINITY
        : options.now - Date.parse(event.createdAt);
    if (ageMs > options.staleClaimHours * MS_PER_HOUR) {
      await removeLabel(token, repo, item.number, claimLabel);
      await createComment(
        token,
        repo,
        item.number,
        `Released a stale \`${claimLabel}\` claim (older than ${options.staleClaimHours}h); the job will retry on a later tick.`,
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
    .filter((item) => !item.labels.includes(claimLabel))
    .sort((a, b) => a.number - b.number);

type RunBudget = {
  remaining: number;
};

const runJobQueue = async (
  repo: string,
  items: ReadonlyArray<IssueItem>,
  budget: RunBudget,
  runJob: (item: IssueItem) => Promise<JobResult>,
): Promise<ReadonlyArray<string>> => {
  const lines: Array<string> = [];
  for (const item of items) {
    if (budget.remaining <= 0) {
      lines.push(`${repo}: run cap reached; remaining jobs wait`);
      break;
    }
    // biome-ignore lint/performance/noAwaitInLoops: jobs are heavyweight Codex runs claimed by label; running them sequentially IS the concurrency cap.
    const result = await runJob(item);
    lines.push(...result.lines.map((line) => `${repo} ${line}`));
    budget.remaining -= result.ranCodex ? 1 : 0;
  }
  return lines;
};

const processRepo = async (
  deps: JobDeps,
  budget: RunBudget,
  now: number,
): Promise<ReadonlyArray<string>> => {
  const { config, token, repo } = deps;
  const lines: Array<string> = [];
  for (const claimLabel of [FIX_IN_PROGRESS, REVIEW_IN_PROGRESS]) {
    // biome-ignore lint/performance/noAwaitInLoops: sweeps issue GitHub writes; GitHub advises against concurrent write requests (secondary rate limits).
    const swept = await sweepStaleClaims({
      token,
      repo,
      claimLabel,
      staleClaimHours: config.staleClaimHours,
      now,
    });
    lines.push(...swept);
  }
  const reviewItems = unclaimed(
    (await listOpenIssuesWithLabel(token, repo, REVIEW_APPROVED)).filter(
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
  const defaultBranch =
    fixItems.length > 0 ? await repoDefaultBranch(token, repo) : '';
  lines.push(
    ...(await runJobQueue(repo, reviewItems, budget, (item) =>
      runReviewJob(deps, item),
    )),
    ...(await runJobQueue(repo, fixItems, budget, (item) =>
      runFixJob(deps, item, defaultBranch),
    )),
  );
  return lines;
};

export const runPollerTick = async (
  config: PollerConfig,
  token: string | null,
  now: number,
): Promise<TickReport> => {
  const lines: Array<string> = [];
  const problems: Array<string> = [];
  const roleCache: RoleCache = new Map();
  const budget: RunBudget = { remaining: config.maxJobsPerTick };

  for (const repo of config.repos) {
    const deps: JobDeps = { config, token, repo, roleCache };
    try {
      // biome-ignore lint/performance/noAwaitInLoops: repositories are processed sequentially so the shared run budget and GitHub write-rate guidance hold.
      lines.push(...(await processRepo(deps, budget, now)));
    } catch (error) {
      problems.push(
        `${repo}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { lines, problems };
};
