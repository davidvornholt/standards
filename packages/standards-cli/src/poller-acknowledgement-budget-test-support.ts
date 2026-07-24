import { createHash } from 'node:crypto';
import { runPollerAcknowledgementTick } from './poller-acknowledgements';
import { issueRevision, prRevision } from './poller-approval';
import { hiddenCommentMetadata } from './poller-comment-metadata';
import { parsePollerConfig } from './poller-config';
import type { IssueItem } from './poller-github';
import { QUEUE_METADATA_MARKER } from './poller-protocol';
import {
  type ReviewPublicationPlan,
  reviewPlanMarker,
} from './poller-review-output';
import { ACKNOWLEDGEMENT_INTERVAL_MINUTES } from './poller-units';

const REPOSITORY_COUNT = 12;
const APPROVED_AT = '2026-07-18T10:00:00Z';
const SHA_LENGTH = 40;
const FIX_NUMBER_START = 100;
const REVIEW_NUMBER_START = 200;
const PLAN_COMMENT_OFFSET = 1000;
const ISSUE_PATH = /\/issues\/\d+$/u;
const BASE_SHA = '1'.repeat(SHA_LENGTH);
const HEAD_SHA = '2'.repeat(SHA_LENGTH);
const repos = Array.from(
  { length: REPOSITORY_COUNT },
  (_, index) => `owner/repo-${index + 1}`,
);

export type BudgetScenario = {
  readonly fixes: number;
  readonly reviews: number;
  readonly persistedPlans: boolean;
};

const item = (number: number, kind: 'fix' | 'review'): IssueItem => ({
  number,
  title: `Title ${number}`,
  body: `Body ${number}`,
  isPullRequest: kind === 'review',
  labels: [`approved-for-${kind}`],
  authorLogin: 'reporter',
});

const rawIssue = (number: number, kind: 'fix' | 'review') => ({
  number,
  title: `Title ${number}`,
  body: `Body ${number}`,
  labels: [{ name: `approved-for-${kind}` }],
  user: { login: 'reporter' },
  ...(kind === 'review'
    ? Object.fromEntries([['pull_request', { url: 'x' }]])
    : {}),
});

const approvalCheckpoint = (number: number, kind: 'fix' | 'review') => ({
  actorLogin: 'maintainer',
  approvedAt: APPROVED_AT,
  eventId: number,
  target:
    kind === 'fix'
      ? issueRevision(item(number, kind))
      : prRevision('main', BASE_SHA, HEAD_SHA),
});

const queueComment = (number: number, kind: 'fix' | 'review') => ({
  id: number,
  body: hiddenCommentMetadata(QUEUE_METADATA_MARKER, {
    approvalId: `approval-${number}`,
    kind,
    approval: approvalCheckpoint(number, kind),
  }),
  user: { login: 'poller' },
  ...Object.fromEntries([['created_at', APPROVED_AT]]),
});

const reviewPlan = (repo: string, number: number): ReviewPublicationPlan => {
  const fields = {
    repo,
    issueNumber: number,
    eventId: number,
    label: 'approved-for-review',
    actorLogin: 'maintainer',
    approvedAt: APPROVED_AT,
    target: prRevision('main', BASE_SHA, HEAD_SHA),
  };
  return {
    repo,
    prNumber: number,
    approvalId: createHash('sha256')
      .update(JSON.stringify(fields))
      .digest('hex'),
    approvedHead: HEAD_SHA,
    publishedHead: HEAD_SHA,
    baseRef: 'main',
    baseSha: BASE_SHA,
    report: 'Reviewed.',
    commits: 0,
    deferred: [],
  };
};

const numberedItems = (count: number, offset: number, kind: 'fix' | 'review') =>
  Array.from({ length: count }, (_, index) => rawIssue(offset + index, kind));

const config = () => {
  const parsed = parsePollerConfig(
    { repos, model: 'gpt-test', reasoningEffort: 'high' },
    '/tmp',
  );
  if (parsed.config === null) {
    throw new Error('test config must parse');
  }
  return parsed.config;
};

const responseBody = (url: URL, scenario: BudgetScenario): unknown => {
  const parts = url.pathname.split('/');
  const repo = `${parts[2]}/${parts[3]}`;
  const number = Number(parts[5]);
  const kind = number >= REVIEW_NUMBER_START ? 'review' : 'fix';
  if (url.pathname.endsWith('/issues')) {
    return url.searchParams.get('labels') === 'approved-for-review'
      ? numberedItems(scenario.reviews, REVIEW_NUMBER_START, 'review')
      : numberedItems(scenario.fixes, FIX_NUMBER_START, 'fix');
  }
  if (url.pathname.includes('/pulls/')) {
    return {
      ...Object.fromEntries([['node_id', 'PR_node']]),
      draft: true,
      head: {
        ref: 'feature',
        sha: HEAD_SHA,
        repo: Object.fromEntries([['full_name', repo]]),
      },
      base: { ref: 'main', sha: BASE_SHA },
    };
  }
  if (url.pathname.endsWith('/comments')) {
    return [
      queueComment(number, kind),
      ...(kind === 'review' && scenario.persistedPlans
        ? [
            {
              id: number + PLAN_COMMENT_OFFSET,
              body: reviewPlanMarker(reviewPlan(repo, number)),
              user: { login: 'poller' },
            },
          ]
        : []),
    ];
  }
  if (url.pathname.endsWith('/timeline')) {
    return [
      {
        id: number,
        event: 'labeled',
        label: { name: `approved-for-${kind}` },
        actor: { login: 'maintainer' },
        ...Object.fromEntries([['created_at', APPROVED_AT]]),
      },
    ];
  }
  if (url.pathname.includes('/collaborators/')) {
    return Object.fromEntries([['role_name', 'admin']]);
  }
  if (ISSUE_PATH.test(url.pathname)) {
    return rawIssue(number, kind);
  }
  throw new Error(`unexpected request: ${url.pathname}`);
};

export const runBudgetScenario = async (
  scenario: BudgetScenario,
): Promise<{
  readonly hourlyRequests: number;
  readonly problems: ReadonlyArray<string>;
}> => {
  let requests = 0;
  globalThis.fetch = ((input: string | URL | Request) => {
    requests += 1;
    try {
      return Promise.resolve(
        Response.json(responseBody(new URL(String(input)), scenario)),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }) as typeof fetch;
  const report = await runPollerAcknowledgementTick(config(), 'test-token');
  return {
    hourlyRequests: requests * (60 / ACKNOWLEDGEMENT_INTERVAL_MINUTES),
    problems: report.problems,
  };
};
