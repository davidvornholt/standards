import { afterEach, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { installApi } from './github-commands-test-support';
import { runPollerAcknowledgementTick } from './poller-acknowledgements';
import { prRevision } from './poller-approval';
import { parsePollerConfig } from './poller-config';
import {
  type ReviewPublicationPlan,
  reviewPlanMarker,
} from './poller-review-output';

const originalFetch = globalThis.fetch;
const REPO = 'owner/repo';
const ISSUE_NUMBER = 7;
const GIT_SHA_LENGTH = 40;
const BASE_SHA = '1'.repeat(GIT_SHA_LENGTH);
const HEAD_SHA = '2'.repeat(GIT_SHA_LENGTH);
const APPROVED_AT = '2026-07-18T10:00:00Z';
const APPROVAL_EVENT_ID = 101;

const rawIssue = {
  number: ISSUE_NUMBER,
  title: 'Title',
  body: 'Body',
  labels: [{ name: 'approved-for-review' }],
  user: { login: 'reporter' },
  ...Object.fromEntries([['pull_request', { url: 'x' }]]),
};

const pullRequest = (options: {
  readonly draft: boolean;
  readonly headRepo: string;
}) => ({
  ...Object.fromEntries([['node_id', 'PR_node']]),
  title: 'Title',
  body: 'Body',
  draft: options.draft,
  head: {
    ref: 'feature',
    sha: HEAD_SHA,
    repo: Object.fromEntries([['full_name', options.headRepo]]),
  },
  base: { ref: 'main', sha: BASE_SHA },
});

const approvalFields = {
  repo: REPO,
  issueNumber: ISSUE_NUMBER,
  eventId: APPROVAL_EVENT_ID,
  label: 'approved-for-review',
  actorLogin: 'maintainer',
  approvedAt: APPROVED_AT,
  target: prRevision('main', BASE_SHA, HEAD_SHA),
};

const approvalId = createHash('sha256')
  .update(JSON.stringify(approvalFields))
  .digest('hex');

const plan: ReviewPublicationPlan = {
  repo: REPO,
  prNumber: ISSUE_NUMBER,
  approvalId,
  approvedHead: HEAD_SHA,
  publishedHead: HEAD_SHA,
  baseRef: 'main',
  baseSha: BASE_SHA,
  report: 'Reviewed.',
  commits: 0,
  deferred: [],
};

const planComment = {
  id: 500,
  body: reviewPlanMarker(plan),
  user: { login: 'poller' },
  ...Object.fromEntries([['created_at', APPROVED_AT]]),
};

const planValidationResponses = [
  { body: [planComment] },
  { body: Object.fromEntries([['role_name', 'admin']]) },
  { body: rawIssue },
  {
    body: [
      {
        id: APPROVAL_EVENT_ID,
        event: 'labeled',
        label: { name: 'approved-for-review' },
        actor: { login: 'maintainer' },
        ...Object.fromEntries([['created_at', APPROVED_AT]]),
      },
    ],
  },
  { body: Object.fromEntries([['role_name', 'admin']]) },
] as const;

const config = () => {
  const parsed = parsePollerConfig(
    {
      repos: [REPO],
      model: 'gpt-test',
      reasoningEffort: 'high',
    },
    '/tmp',
  );
  if (parsed.config === null) {
    throw new Error('test config must parse');
  }
  return parsed.config;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it.each([
  [
    'persisted plan',
    pullRequest({ draft: true, headRepo: REPO }),
    [{ body: [planComment] }, ...planValidationResponses],
  ],
  [
    'ready PR without a plan',
    pullRequest({ draft: false, headRepo: REPO }),
    [{ body: [] }],
  ],
  [
    'fork PR',
    pullRequest({ draft: true, headRepo: 'contributor/repo' }),
    [{ body: [] }],
  ],
] as const)('does not promise a review for a %s', async (_description, pr, eligibilityResponses) => {
  const calls = installApi([
    { body: [rawIssue] },
    { body: [] },
    { body: pr },
    ...eligibilityResponses,
  ]);
  const report = await runPollerAcknowledgementTick(config(), 'test-token');
  expect(report).toEqual({ lines: [], problems: [] });
  expect(calls.every((call) => call.method === 'GET')).toBe(true);
});
