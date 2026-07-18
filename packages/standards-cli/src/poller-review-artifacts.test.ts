import { afterEach, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { type ApiCall, installApi } from './github-commands-test-support';
import type { JobDeps } from './poller-job-shared';
import { CLAIM_MARKER } from './poller-protocol';
import { publishReviewArtifacts } from './poller-review-artifacts';
import type { ReviewPublicationPlan } from './poller-review-output';

const originalFetch = globalThis.fetch;
const PR_NUMBER = 4;
const RELEASE_LABEL_COUNT = 3;
const approvalFields = {
  label: 'approved-for-review',
  actorLogin: 'maintainer',
  approvedAt: '2026-07-18T10:00:00Z',
  target: 'pr:head',
};
const approval = {
  id: createHash('sha256').update(JSON.stringify(approvalFields)).digest('hex'),
  ...approvalFields,
};
const claim = {
  approval,
  claimLabel: 'review-in-progress',
  claimEpoch: '2026-07-18T11:00:00Z',
  markerId: 9,
};
const plan: ReviewPublicationPlan = {
  approvalId: approval.id,
  approvedHead: 'head',
  publishedHead: 'head',
  baseRef: 'main',
  baseSha: 'base',
  report: 'Report',
  commits: 0,
  deferred: [{ title: 'Follow up', body: 'Evidence.' }],
};
const deps = {
  token: 'token',
  repo: 'owner/repo',
  roleCache: new Map(),
} as JobDeps;
const pr = {
  number: PR_NUMBER,
  title: 'Title',
  body: 'Body',
  headRef: 'feature',
  headSha: 'head',
  headRepo: 'owner/repo',
  baseRef: 'main',
  baseSha: 'base',
  nodeId: 'PR_node',
  draft: false,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const validationResponses = () => [
  {
    body: {
      ...Object.fromEntries([['node_id', 'PR_node']]),
      draft: false,
      head: {
        ref: 'feature',
        sha: 'head',
        repo: Object.fromEntries([['full_name', 'owner/repo']]),
      },
      base: { ref: 'main', sha: 'base' },
    },
  },
  {
    body: {
      number: PR_NUMBER,
      labels: [{ name: 'approved-for-review' }],
    },
  },
  {
    body: [
      {
        event: 'labeled',
        label: { name: 'approved-for-review' },
        actor: { login: 'maintainer' },
        ...Object.fromEntries([['created_at', approval.approvedAt]]),
      },
    ],
  },
  { body: Object.fromEntries([['role_name', 'maintain']]) },
  {
    body: {
      number: PR_NUMBER,
      labels: [{ name: 'review-in-progress' }],
    },
  },
  {
    body: [
      {
        id: claim.markerId,
        body: `${CLAIM_MARKER}\n${JSON.stringify({
          approval,
          claimLabel: claim.claimLabel,
          claimEpoch: claim.claimEpoch,
          nonce: 'nonce',
        })}`,
        user: { login: 'poller' },
      },
    ],
  },
  { body: Object.fromEntries([['role_name', 'admin']]) },
];

it('replays a fully published ready review without duplicate artifacts', async () => {
  const calls: ReadonlyArray<ApiCall> = installApi([
    {
      body: [
        {
          body: `<!-- standards-poller:review approval=${approval.id} -->`,
          ...Object.fromEntries([['commit_id', 'head']]),
        },
      ],
    },
    {
      body: [
        {
          body: `<!-- standards-poller:deferred approval=${approval.id} index=0 -->`,
        },
      ],
    },
    ...validationResponses(),
    ...validationResponses(),
    { body: {} },
    { body: {} },
    { body: {} },
  ]);
  await publishReviewArtifacts({
    deps,
    labels: {
      approved: 'approved-for-review',
      inProgress: 'review-in-progress',
      failed: 'review-failed',
    },
    pr,
    claim,
    plan,
  });
  expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
  expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(
    RELEASE_LABEL_COUNT,
  );
});
