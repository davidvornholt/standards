import { afterEach, expect, it } from 'bun:test';
import { installApi } from './github-commands-test-support';
import { parsePollerConfig } from './poller-config';
import { runFixJob } from './poller-fix-run';
import type { IssueItem } from './poller-github';
import { runReviewJob } from './poller-review-run';

const originalFetch = globalThis.fetch;
const ISSUE_NUMBER = 7;
const parsed = parsePollerConfig(
  {
    repos: ['owner/repo'],
    model: 'gpt-test',
    reasoningEffort: 'high',
  },
  '/tmp',
);
if (parsed.config === null) {
  throw new Error('test config must parse');
}
const deps = {
  config: parsed.config,
  token: 'token',
  repo: 'owner/repo',
  roleCache: new Map(),
};
const item = (kind: 'fix' | 'review'): IssueItem => ({
  number: ISSUE_NUMBER,
  title: 'Title',
  body: 'Body',
  isPullRequest: kind === 'review',
  labels: [`approved-for-${kind}`],
  authorLogin: 'reporter',
});
const staleIssue = {
  number: ISSUE_NUMBER,
  title: 'Title',
  body: 'Body',
  labels: [],
  user: { login: 'reporter' },
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it('skips a stale fix before resolving its default branch', async () => {
  const calls = installApi([{ body: staleIssue }]);
  let resolvedDefaultBranch = false;

  const result = await runFixJob(deps, item('fix'), () => {
    resolvedDefaultBranch = true;
    return Promise.reject(new Error('default branch unavailable'));
  });

  expect(result).toEqual({
    lines: [`#${ISSUE_NUMBER}: approval no longer present; skipped`],
    ranCodex: false,
  });
  expect(resolvedDefaultBranch).toBe(false);
  expect(calls).toHaveLength(1);
});

it('skips a stale review before reading pull-request prerequisites', async () => {
  const calls = installApi([{ body: staleIssue }]);

  const result = await runReviewJob(deps, item('review'));

  expect(result).toEqual({
    lines: [`PR #${ISSUE_NUMBER}: approval no longer present; skipped`],
    ranCodex: false,
  });
  expect(calls).toHaveLength(1);
});
