import { createHash } from 'node:crypto';
import { prRevision } from './poller-approval';
import { hiddenCommentMetadata } from './poller-comment-metadata';
import type { JobDeps } from './poller-job-shared';
import { CLAIM_METADATA_MARKER } from './poller-protocol';
import type { ReviewPublicationPlan } from './poller-review-output';
import { agentReviewThreadMarker } from './poller-review-threads';

export const PR_NUMBER = 4;
const SHA_LENGTH = 64;
const approvalFields = {
  repo: 'owner/repo',
  issueNumber: PR_NUMBER,
  eventId: 101,
  label: 'approved-for-review',
  actorLogin: 'maintainer',
  approvedAt: '2026-07-18T10:00:00Z',
  target: prRevision('main', 'base', 'head'),
};
export const approval = {
  id: createHash('sha256').update(JSON.stringify(approvalFields)).digest('hex'),
  ...approvalFields,
};
export const claim = {
  approval,
  claimLabel: 'review-in-progress',
  claimEpoch: '2026-07-18T11:00:00Z',
  markerId: 9,
};
export const resolution = {
  threadId: 'PRRT_thread',
  verificationReply: 'Fixed in the reviewed head; focused tests pass.',
};
export const plan: ReviewPublicationPlan = {
  repo: 'owner/repo',
  prNumber: PR_NUMBER,
  approvalId: approval.id,
  approvedHead: 'head',
  publishedHead: 'head',
  baseRef: 'main',
  baseSha: 'base',
  report: 'Report',
  commits: 0,
  threadsToResolve: [resolution],
};
export const deps = {
  token: 'token',
  repo: 'owner/repo',
  roleCache: new Map(),
} as JobDeps;
export const pr = {
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

export const threadResponse = (
  options: {
    readonly body?: string;
    readonly creationBody?: string;
    readonly creationViewerDidAuthor?: boolean;
    readonly isResolved?: boolean;
    readonly prNumber?: number;
    readonly repo?: string;
  } = {},
) => ({
  body: {
    data: {
      node: {
        id: resolution.threadId,
        isResolved: options.isResolved ?? false,
        pullRequest: {
          number: options.prNumber ?? PR_NUMBER,
          repository: { nameWithOwner: options.repo ?? 'owner/repo' },
        },
        comments: {
          nodes: [
            {
              body:
                options.creationBody ??
                `Finding.\n\n${agentReviewThreadMarker(approval.id, 'a'.repeat(SHA_LENGTH))}`,
              viewerDidAuthor: options.creationViewerDidAuthor ?? true,
            },
            ...(options.body === undefined
              ? []
              : [{ body: options.body, viewerDidAuthor: true }]),
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  },
});

export const validationResponses = () => [
  {
    body: {
      ...Object.fromEntries([['node_id', 'PR_node']]),
      draft: true,
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
      title: 'Title',
      body: 'Body',
      labels: [{ name: 'approved-for-review' }],
      user: { login: 'author' },
    },
  },
  {
    body: [
      {
        id: approval.eventId,
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
      title: 'Title',
      body: 'Body',
      labels: [{ name: 'review-in-progress' }],
      user: { login: 'author' },
    },
  },
  {
    body: [
      {
        id: claim.markerId,
        body: hiddenCommentMetadata(CLAIM_METADATA_MARKER, {
          approval,
          claimLabel: claim.claimLabel,
          claimEpoch: claim.claimEpoch,
          nonce: 'nonce',
        }),
        user: { login: 'poller' },
      },
    ],
  },
  { body: Object.fromEntries([['role_name', 'admin']]) },
];
