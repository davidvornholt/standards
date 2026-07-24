import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { installPollerApi } from './poller-api-test-support';
import {
  type ApprovalBinding,
  issueRevision,
  prRevision,
} from './poller-approval';
import { parsePollerConfig } from './poller-config';
import { sealFixOutput } from './poller-fix-output';
import { runFixJob } from './poller-fix-run';
import type { IssueItem } from './poller-github';
import {
  checkout,
  commitFile,
  createLocalPollerRepo,
  pushRef,
} from './poller-job-run-test-support';
import { branchNameForIssue } from './poller-protocol';
import {
  type ReviewPublicationPlan,
  reviewOutputBranch,
  sealReviewPlan,
} from './poller-review-output';
import { runReviewJob } from './poller-review-run';

const originalFetch = globalThis.fetch;
const REPO = 'owner/repo';
const ISSUE_NUMBER = 7;
const roots: Array<string> = [];

const issue = (isPullRequest: boolean): IssueItem => ({
  number: ISSUE_NUMBER,
  title: 'Title',
  body: 'Body',
  isPullRequest,
  labels: [isPullRequest ? 'approved-for-review' : 'approved-for-fix'],
  authorLogin: 'reporter',
});

const approval = (label: string, target: string): ApprovalBinding => {
  const fields = {
    repo: REPO,
    issueNumber: ISSUE_NUMBER,
    eventId: 101,
    label,
    actorLogin: 'maintainer',
    approvedAt: '2026-07-18T10:00:00Z',
    target,
  };
  return {
    id: createHash('sha256').update(JSON.stringify(fields)).digest('hex'),
    ...fields,
  };
};

const deps = (cacheDir: string) => {
  const parsed = parsePollerConfig(
    {
      repos: [REPO],
      model: 'gpt-test',
      reasoningEffort: 'high',
      cacheDir,
    },
    '/tmp',
  );
  if (parsed.config === null) {
    throw new Error('test config must parse');
  }
  return {
    config: parsed.config,
    token: 'token',
    repo: REPO,
    roleCache: new Map(),
  };
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('poller entrypoints without Codex capacity', () => {
  it.each([
    'fix',
    'review',
  ] as const)('acknowledges a fresh %s job once without claiming it', async (kind) => {
    const fixture = createLocalPollerRepo();
    roots.push(fixture.root);
    const isReview = kind === 'review';
    const calls = installPollerApi({
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      isPullRequest: isReview,
    });
    const result = isReview
      ? await runReviewJob(deps(fixture.cacheDir), issue(true), false)
      : await runFixJob(deps(fixture.cacheDir), issue(false), 'main', false);
    const second = isReview
      ? await runReviewJob(deps(fixture.cacheDir), issue(true), false)
      : await runFixJob(deps(fixture.cacheDir), issue(false), 'main', false);
    expect(result.ranCodex).toBe(false);
    expect(second.ranCodex).toBe(false);
    expect(result.lines[0]).toContain('waiting for run capacity');
    const mutations = calls.filter((call) => call.method !== 'GET');
    expect(mutations).toHaveLength(1);
    const [comment] = mutations;
    expect(comment?.method).toBe('POST');
    const body = (comment?.body as { readonly body?: unknown } | null)?.body;
    expect(body).toStartWith(isReview ? '**Review queued**' : '**Fix queued**');
    expect(body).toContain('<!-- standards-poller:queue\n');
  });

  it('continues a sealed fix publication', async () => {
    const fixture = createLocalPollerRepo();
    roots.push(fixture.root);
    const item = issue(false);
    const binding = approval('approved-for-fix', issueRevision(item));
    checkout(fixture.source, fixture.baseSha);
    const generatedHead = commitFile(fixture.source, 'fixed.txt', 'fixed\n');
    const sealed = sealFixOutput(fixture.source, {
      repo: REPO,
      issueNumber: ISSUE_NUMBER,
      approvalId: binding.id,
      title: 'fix(poller): recover output',
      body: 'Recovered.',
      baseSha: fixture.baseSha,
      commits: 1,
    });
    expect(sealed.generatedHead).toBe(generatedHead);
    pushRef(
      fixture.source,
      branchNameForIssue(ISSUE_NUMBER, binding.id),
      sealed.sealedHead,
    );
    const calls = installPollerApi({
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      isPullRequest: false,
    });
    const result = await runFixJob(deps(fixture.cacheDir), item, 'main', false);
    expect(result).toEqual({
      lines: [`#${ISSUE_NUMBER}: opened draft PR #44`],
      ranCodex: false,
    });
    expect(
      calls.some(
        (call) => call.method === 'POST' && call.path.endsWith('/pulls'),
      ),
    ).toBe(true);
  });

  it('continues a sealed review publication', async () => {
    const fixture = createLocalPollerRepo();
    roots.push(fixture.root);
    const item = issue(true);
    const binding = approval(
      'approved-for-review',
      prRevision('main', fixture.baseSha, fixture.headSha),
    );
    const plan: ReviewPublicationPlan = {
      repo: REPO,
      prNumber: ISSUE_NUMBER,
      approvalId: binding.id,
      approvedHead: fixture.headSha,
      publishedHead: fixture.headSha,
      baseRef: 'main',
      baseSha: fixture.baseSha,
      report: 'Reviewed.',
      commits: 0,
      deferred: [],
    };
    checkout(fixture.source, fixture.headSha);
    const sealedHead = sealReviewPlan(fixture.source, plan);
    pushRef(fixture.source, reviewOutputBranch(plan), sealedHead);
    const calls = installPollerApi({
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      isPullRequest: true,
    });
    const result = await runReviewJob(deps(fixture.cacheDir), item, false);
    expect(result).toEqual({
      lines: [
        `PR #${ISSUE_NUMBER}: reviewed (0 fix commit(s), 0 deferred issue(s)), marked ready`,
      ],
      ranCodex: false,
    });
    expect(
      calls.some(
        (call) => call.method === 'POST' && call.path.endsWith('/reviews'),
      ),
    ).toBe(true);
  });
});
