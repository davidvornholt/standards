import {
  issueRevision,
  prRevision,
  readApprovalBinding,
} from './poller-approval';
import type { PollerConfig } from './poller-config';
import { type IssueItem, listOpenIssuesWithLabel } from './poller-github';
import { getPullRequest } from './poller-github-pulls';
import type { JobDeps } from './poller-job-shared';
import { APPROVED_FOR_FIX, APPROVED_FOR_REVIEW } from './poller-protocol';
import { readReviewPlan } from './poller-review-state';
import { acknowledgeQueuedJob, type PollerJobKind } from './poller-status';
import type { RoleCache } from './poller-trust';

export type AcknowledgementReport = {
  readonly lines: ReadonlyArray<string>;
  readonly problems: ReadonlyArray<string>;
};

const approvalFor = async (
  deps: JobDeps,
  item: IssueItem,
  kind: PollerJobKind,
) => {
  let target = issueRevision(item);
  if (kind === 'review') {
    const pr = await getPullRequest(deps.token, deps.repo, item.number);
    const plan = await readReviewPlan(deps, pr);
    target = prRevision(
      pr.baseRef,
      pr.baseSha,
      plan?.approvedHead ?? pr.headSha,
    );
  }
  return readApprovalBinding(
    {
      token: deps.token,
      repo: deps.repo,
      issueNumber: item.number,
    },
    kind === 'fix' ? APPROVED_FOR_FIX : APPROVED_FOR_REVIEW,
    target,
  );
};

const acknowledgeItems = async (options: {
  readonly deps: JobDeps;
  readonly items: ReadonlyArray<IssueItem>;
  readonly kind: PollerJobKind;
  readonly lines: Array<string>;
  readonly problems: Array<string>;
}): Promise<void> => {
  const { deps, items, kind, lines, problems } = options;
  for (const item of items) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: acknowledgement writes are deliberately serialized to avoid GitHub secondary rate limits.
      const approval = await approvalFor(deps, item, kind);
      if (
        typeof approval !== 'string' &&
        (await acknowledgeQueuedJob(deps, item.number, approval, kind))
      ) {
        lines.push(
          `${deps.repo} ${kind === 'fix' ? `#${item.number}` : `PR #${item.number}`}: acknowledged as queued`,
        );
      }
    } catch (error) {
      problems.push(
        `${deps.repo}#${item.number}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
};

const acknowledgeRepository = async (
  deps: JobDeps,
  lines: Array<string>,
  problems: Array<string>,
): Promise<void> => {
  const reviews = (
    await listOpenIssuesWithLabel(deps.token, deps.repo, APPROVED_FOR_REVIEW)
  ).filter((item) => item.isPullRequest);
  const fixes = (
    await listOpenIssuesWithLabel(deps.token, deps.repo, APPROVED_FOR_FIX)
  ).filter((item) => !item.isPullRequest);
  await acknowledgeItems({
    deps,
    items: reviews,
    kind: 'review',
    lines,
    problems,
  });
  await acknowledgeItems({
    deps,
    items: fixes,
    kind: 'fix',
    lines,
    problems,
  });
};

export const runPollerAcknowledgementTick = async (
  config: PollerConfig,
  token: string | null,
): Promise<AcknowledgementReport> => {
  const lines: Array<string> = [];
  const problems: Array<string> = [];
  const roleCache: RoleCache = new Map();
  for (const repo of config.repos) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: repository scans share a rate-limited GitHub token and keep writes serialized.
      await acknowledgeRepository(
        { config, token, repo, roleCache },
        lines,
        problems,
      );
    } catch (error) {
      problems.push(
        `${repo}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { lines, problems };
};
