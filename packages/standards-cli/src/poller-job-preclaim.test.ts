import { afterEach, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { installApi } from './github-commands-test-support';
import { parsePollerConfig } from './poller-config';
import { runFixJob } from './poller-fix-run';
import type { IssueItem } from './poller-github';
import { createLocalPollerRepo } from './poller-job-run-test-support';
import { runReviewJob } from './poller-review-run';

const originalFetch = globalThis.fetch;
const REPO = 'owner/repo';
const ISSUE_NUMBER = 7;
const SUPERSEDING_EVENT_ID = 102;
const roots: Array<string> = [];

const item = (kind: 'fix' | 'review'): IssueItem => ({
  number: ISSUE_NUMBER,
  title: 'Title',
  body: 'Body',
  isPullRequest: kind === 'review',
  labels: [`approved-for-${kind}`],
  authorLogin: 'reporter',
});

const rawIssue = (kind: 'fix' | 'review', approved = true) => ({
  number: ISSUE_NUMBER,
  title: 'Title',
  body: 'Body',
  labels: approved ? [{ name: `approved-for-${kind}` }] : [],
  user: { login: 'reporter' },
  ...(kind === 'review'
    ? Object.fromEntries([['pull_request', { url: 'x' }]])
    : {}),
});

const event = (kind: 'fix' | 'review', id = 101) => ({
  id,
  event: 'labeled',
  label: { name: `approved-for-${kind}` },
  actor: { login: 'maintainer' },
  ...Object.fromEntries([['created_at', '2026-07-18T10:00:00Z']]),
});

const role = {
  body: Object.fromEntries([['role_name', 'admin']]),
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

it('skips a fix without writes when approval disappears before claim', async () => {
  const fixture = createLocalPollerRepo();
  roots.push(fixture.root);
  const calls = installApi([
    { body: rawIssue('fix') },
    { body: rawIssue('fix') },
    { body: [event('fix')] },
    role,
    { body: [] },
    { body: rawIssue('fix', false) },
  ]);

  const result = await runFixJob(deps(fixture.cacheDir), item('fix'), () =>
    Promise.resolve('main'),
  );

  expect(result).toEqual({
    lines: [`#${ISSUE_NUMBER}: approval generation changed; skipped`],
    ranCodex: false,
  });
  expect(calls.every(({ method }) => method === 'GET')).toBe(true);
});

it('skips a review without writes when approval is superseded before claim', async () => {
  const fixture = createLocalPollerRepo();
  roots.push(fixture.root);
  const pullRequest = {
    ...Object.fromEntries([['node_id', 'PR_node']]),
    title: 'Title',
    body: 'Body',
    draft: true,
    head: {
      ref: 'feature',
      sha: fixture.headSha,
      repo: Object.fromEntries([['full_name', REPO]]),
    },
    base: { ref: 'main', sha: fixture.baseSha },
  };
  const calls = installApi([
    { body: rawIssue('review') },
    { body: pullRequest },
    { body: [] },
    { body: rawIssue('review') },
    { body: [event('review')] },
    role,
    { body: [] },
    { body: rawIssue('review') },
    { body: [event('review', SUPERSEDING_EVENT_ID)] },
    role,
  ]);

  const result = await runReviewJob(deps(fixture.cacheDir), item('review'));

  expect(result).toEqual({
    lines: [`PR #${ISSUE_NUMBER}: approval generation changed; skipped`],
    ranCodex: false,
  });
  expect(calls.every(({ method }) => method === 'GET')).toBe(true);
});
