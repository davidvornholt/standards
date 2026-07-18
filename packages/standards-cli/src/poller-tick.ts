// One poller tick: sweep stale claims, then run approved jobs oldest-first —
// review jobs before fix jobs, because reviews unblock merges — under the
// per-tick Codex run cap. All state lives in GitHub, so a tick is re-runnable
// and a crash costs at most one stale claim that the next tick sweeps.

import type { PollerConfig } from './poller-config';
import { runFixJob } from './poller-fix-run';
import { repoDefaultBranch } from './poller-github';
import type { JobDeps, JobResult } from './poller-job-shared';
import { runReviewJob } from './poller-review-run';
import { discoverRepositoryJobs, type ScheduledJob } from './poller-schedule';
import type { RoleCache } from './poller-trust';

export type TickReport = {
  readonly lines: ReadonlyArray<string>;
  readonly problems: ReadonlyArray<string>;
};

type RunBudget = {
  remaining: number;
};

export type TickJobRunners = {
  readonly review: typeof runReviewJob;
  readonly fix: typeof runFixJob;
};

const DEFAULT_JOB_RUNNERS: TickJobRunners = {
  review: runReviewJob,
  fix: runFixJob,
};

type TypedScheduledJob = ScheduledJob & {
  readonly kind: 'review' | 'fix';
};

const approvalTime = (job: ScheduledJob): number => {
  const parsed = Date.parse(job.approvedAt);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
};

const kindPriority = (
  left: TypedScheduledJob,
  right: TypedScheduledJob,
): number => {
  if (left.kind === right.kind) {
    return 0;
  }
  return left.kind === 'review' ? -1 : 1;
};

const byGlobalPriority = (
  left: TypedScheduledJob,
  right: TypedScheduledJob,
): number =>
  approvalTime(left) - approvalTime(right) ||
  kindPriority(left, right) ||
  left.deps.repo.localeCompare(right.deps.repo) ||
  left.item.number - right.item.number;

const runQueue = async (options: {
  readonly queue: ReadonlyArray<TypedScheduledJob>;
  readonly token: string | null;
  readonly runners: TickJobRunners;
  readonly budget: RunBudget;
  readonly lines: Array<string>;
  readonly problems: Array<string>;
  readonly defaultBranches: Map<string, string>;
}): Promise<void> => {
  const { queue, token, runners, budget, lines, problems, defaultBranches } =
    options;
  for (const job of queue) {
    try {
      let result: JobResult;
      const allowCodex = budget.remaining > 0;
      if (job.kind === 'review') {
        // biome-ignore lint/performance/noAwaitInLoops: jobs are heavyweight Codex runs and the shared run budget is the concurrency cap.
        result = await runners.review(job.deps, job.item, allowCodex);
      } else {
        let defaultBranch = defaultBranches.get(job.deps.repo);
        if (defaultBranch === undefined) {
          defaultBranch = await repoDefaultBranch(token, job.deps.repo);
          defaultBranches.set(job.deps.repo, defaultBranch);
        }
        result = await runners.fix(
          job.deps,
          job.item,
          defaultBranch,
          allowCodex,
        );
      }
      lines.push(...result.lines.map((line) => `${job.deps.repo} ${line}`));
      budget.remaining -= result.ranCodex ? 1 : 0;
    } catch (error) {
      problems.push(
        `${job.deps.repo}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
};

export const runPollerTick = async (
  config: PollerConfig,
  token: string | null,
  now: number,
  runners: TickJobRunners = DEFAULT_JOB_RUNNERS,
): Promise<TickReport> => {
  const lines: Array<string> = [];
  const problems: Array<string> = [];
  const roleCache: RoleCache = new Map();
  const budget: RunBudget = { remaining: config.maxJobsPerTick };
  const reviews: Array<ScheduledJob> = [];
  const fixes: Array<ScheduledJob> = [];

  for (const repo of config.repos) {
    const deps: JobDeps = { config, token, repo, roleCache };
    try {
      // biome-ignore lint/performance/noAwaitInLoops: discovery includes GitHub timeline reads and stale-claim writes; sequential requests avoid secondary rate limits.
      const discovered = await discoverRepositoryJobs(deps, now);
      lines.push(...discovered.lines);
      reviews.push(...discovered.reviews);
      fixes.push(...discovered.fixes);
    } catch (error) {
      problems.push(
        `${repo}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const defaultBranches = new Map<string, string>();
  const queue: ReadonlyArray<TypedScheduledJob> = [
    ...reviews.map((job) => ({ ...job, kind: 'review' as const })),
    ...fixes.map((job) => ({ ...job, kind: 'fix' as const })),
  ].sort(byGlobalPriority);
  await runQueue({
    queue,
    token,
    runners,
    budget,
    lines,
    problems,
    defaultBranches,
  });
  return { lines, problems };
};
