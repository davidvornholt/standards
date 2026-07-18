import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { installApi } from './github-commands-test-support';
import type { JobDeps } from './poller-job-shared';
import { CLAIM_MARKER } from './poller-protocol';
import type { ReviewPublicationPlan } from './poller-review-output';
import { validateReviewClaim } from './poller-review-state';

const originalFetch = globalThis.fetch;
const PR_NUMBER = 4;
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
  draft: true,
};
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
  deferred: [],
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const rawPr = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  ...Object.fromEntries([['node_id', 'PR_node']]),
  title: 'Title',
  body: 'Body',
  draft: true,
  head: {
    ref: 'feature',
    sha: 'head',
    repo: Object.fromEntries([['full_name', 'owner/repo']]),
  },
  base: { ref: 'main', sha: 'base' },
  ...overrides,
});

describe('validateReviewClaim', () => {
  it('accepts the exact approved draft snapshot with mixed-case labels', async () => {
    installApi([
      { body: rawPr() },
      {
        body: {
          number: 4,
          labels: [
            { name: 'Approved-For-Review' },
            { name: 'Review-In-Progress' },
          ],
        },
      },
      {
        body: [
          {
            event: 'labeled',
            label: { name: 'APPROVED-FOR-REVIEW' },
            actor: { login: 'maintainer' },
            ...Object.fromEntries([['created_at', approval.approvedAt]]),
          },
        ],
      },
      { body: Object.fromEntries([['role_name', 'maintain']]) },
      {
        body: {
          number: 4,
          labels: [{ name: 'REVIEW-IN-PROGRESS' }],
        },
      },
      {
        body: [
          {
            id: 9,
            body: `${CLAIM_MARKER}\n${JSON.stringify({
              approval,
              claimLabel: claim.claimLabel,
              claimEpoch: claim.claimEpoch,
              nonce: 'nonce',
            })}`,
            user: { login: 'poller' },
            ...Object.fromEntries([['created_at', claim.claimEpoch]]),
          },
        ],
      },
      { body: Object.fromEntries([['role_name', 'admin']]) },
    ]);
    await expect(
      validateReviewClaim({
        deps,
        pr,
        claim,
        plan,
        expectedHead: 'head',
        requireDraft: true,
      }),
    ).resolves.toMatchObject({ headSha: 'head', baseSha: 'base', draft: true });
  });

  it.each([
    ['moved head', rawPr({ head: { ...rawPr().head, sha: 'other' } })],
    ['moved base', rawPr({ base: { ref: 'main', sha: 'other' } })],
    ['ready PR', rawPr({ draft: false })],
  ])('blocks publication for a %s', async (_label, body) => {
    installApi([{ body }]);
    await expect(
      validateReviewClaim({
        deps,
        pr,
        claim,
        plan,
        expectedHead: 'head',
        requireDraft: true,
      }),
    ).rejects.toThrow('publication blocked');
  });
});
