import { afterEach, expect, it } from 'bun:test';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installPollerApi } from './poller-api-test-support';
import { prRevision } from './poller-approval';
import { parsePollerConfig } from './poller-config';
import type { IssueItem } from './poller-github';
import { createLocalPollerRepo, pushRef } from './poller-job-run-test-support';
import {
  type ReviewPublicationPlan,
  reviewOutputBranch,
} from './poller-review-output';
import { runReviewJob } from './poller-review-run';
import { localBranchExists } from './poller-workspace';

const originalFetch = globalThis.fetch;
const REPO = 'owner/repo';
const PR_NUMBER = 7;
const OUTPUT_BRANCH_DIGEST_LENGTH = 16;
let root: string | null = null;

const legacyReviewOutputBranch = (
  plan: Pick<
    ReviewPublicationPlan,
    'repo' | 'prNumber' | 'baseSha' | 'approvedHead' | 'approvalId'
  >,
): string => {
  const { repo, prNumber, baseSha, approvedHead, approvalId } = plan;
  const generation = createHash('sha256')
    .update(
      JSON.stringify({ repo, prNumber, baseSha, approvedHead, approvalId }),
    )
    .digest('hex')
    .slice(0, OUTPUT_BRANCH_DIGEST_LENGTH);
  return `poller/review-pr-${prNumber}-${generation}`;
};

const legacyReviewMarker = (plan: Readonly<Record<string, unknown>>): string =>
  `<!-- standards-poller:review-output\n${Buffer.from(JSON.stringify(plan)).toString('base64url')}\n-->`;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (root !== null) {
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
});

it('reruns Codex on v2 when a legacy plan and output branch exist', async () => {
  const fixture = createLocalPollerRepo();
  ({ root } = fixture);
  const approvalFields = {
    repo: REPO,
    issueNumber: PR_NUMBER,
    eventId: 101,
    label: 'approved-for-review',
    actorLogin: 'maintainer',
    approvedAt: '2026-07-18T10:00:00Z',
    target: prRevision('main', fixture.baseSha, fixture.headSha),
  };
  const approvalId = createHash('sha256')
    .update(JSON.stringify(approvalFields))
    .digest('hex');
  const legacyPlan = {
    repo: REPO,
    prNumber: PR_NUMBER,
    approvalId,
    approvedHead: fixture.headSha,
    publishedHead: fixture.headSha,
    baseRef: 'main',
    baseSha: fixture.baseSha,
    report: 'Legacy review.',
    commits: 0,
    deferred: [],
  };
  const legacyBranch = legacyReviewOutputBranch(legacyPlan);
  const v2Branch = reviewOutputBranch(legacyPlan);
  expect(v2Branch).toStartWith(`poller/review-v2-pr-${PR_NUMBER}-`);
  expect(v2Branch).not.toBe(legacyBranch);
  pushRef(fixture.source, legacyBranch, fixture.headSha);
  installPollerApi({
    baseSha: fixture.baseSha,
    headSha: fixture.headSha,
    initialComments: [
      {
        id: 400,
        body: legacyReviewMarker(legacyPlan),
        user: { login: 'poller' },
        ...Object.fromEntries([['created_at', '2026-07-18T10:30:00Z']]),
      },
    ],
    isPullRequest: true,
  });
  const parsed = parsePollerConfig(
    {
      repos: [REPO],
      model: 'gpt-test',
      reasoningEffort: 'high',
      cacheDir: fixture.cacheDir,
    },
    '/tmp',
  );
  if (parsed.config === null) {
    throw new Error('test config must parse');
  }
  const item: IssueItem = {
    number: PR_NUMBER,
    title: 'Title',
    body: 'Body',
    isPullRequest: true,
    labels: ['approved-for-review'],
    authorLogin: 'reporter',
  };
  let runs = 0;
  const result = await runReviewJob(
    {
      config: parsed.config,
      token: 'token',
      repo: REPO,
      roleCache: new Map(),
    },
    item,
    true,
    (options) => {
      runs += 1;
      const outcomeDir = join(options.workDir, '.standards-poller');
      mkdirSync(outcomeDir);
      writeFileSync(
        join(outcomeDir, 'outcome.json'),
        JSON.stringify({
          status: 'cannot-review',
          summary: 'Legacy protocol rerun reached Codex.',
        }),
      );
      return Promise.resolve({ succeeded: true, failure: null });
    },
  );

  expect(result).toEqual({
    lines: [`PR #${PR_NUMBER}: cannot review`],
    ranCodex: true,
  });
  expect(runs).toBe(1);
  expect(localBranchExists(fixture.cacheRepo, legacyBranch)).toBe(true);
  expect(localBranchExists(fixture.cacheRepo, v2Branch)).toBe(false);
});
