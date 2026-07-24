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
const MOVED_HEAD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const roots: Array<string> = [];

const item = (kind: 'fix' | 'review'): IssueItem => ({
  number: ISSUE_NUMBER,
  title: 'Title',
  body: 'Approved body',
  isPullRequest: kind === 'review',
  labels: [`approved-for-${kind}`],
  authorLogin: 'reporter',
});

const rawIssue = (kind: 'fix' | 'review', body = 'Approved body') => ({
  number: ISSUE_NUMBER,
  title: 'Title',
  body,
  labels: [{ name: `approved-for-${kind}` }],
  user: { login: 'reporter' },
  ...(kind === 'review'
    ? Object.fromEntries([['pull_request', { url: 'x' }]])
    : {}),
});

const event = (kind: 'fix' | 'review') => ({
  id: 101,
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

it('skips a fix when its issue body changes before the first write', async () => {
  const fixture = createLocalPollerRepo();
  roots.push(fixture.root);
  const changed = rawIssue('fix', 'Changed body');
  const calls = installApi([
    { body: rawIssue('fix') },
    { body: rawIssue('fix') },
    { body: [event('fix')] },
    role,
    { body: [] },
    { body: rawIssue('fix') },
    { body: [event('fix')] },
    role,
    { body: changed },
  ]);

  const result = await runFixJob(deps(fixture.cacheDir), item('fix'), () =>
    Promise.resolve('main'),
  );

  expect(result).toEqual({
    lines: [`#${ISSUE_NUMBER}: approval no longer present; skipped`],
    ranCodex: false,
  });
  expect(calls.every(({ method }) => method === 'GET')).toBe(true);
});

it('skips a review when its PR head changes before the first write', async () => {
  const fixture = createLocalPollerRepo();
  roots.push(fixture.root);
  const pullRequest = (headSha: string) => ({
    ...Object.fromEntries([['node_id', 'PR_node']]),
    title: 'Title',
    body: 'Body',
    draft: true,
    head: {
      ref: 'feature',
      sha: headSha,
      repo: Object.fromEntries([['full_name', REPO]]),
    },
    base: { ref: 'main', sha: fixture.baseSha },
  });
  const calls = installApi([
    { body: rawIssue('review') },
    { body: pullRequest(fixture.headSha) },
    { body: [] },
    { body: rawIssue('review') },
    { body: [event('review')] },
    role,
    { body: [] },
    { body: rawIssue('review') },
    { body: [event('review')] },
    role,
    { body: pullRequest(MOVED_HEAD) },
  ]);
  let agentCalls = 0;

  const result = await runReviewJob(
    deps(fixture.cacheDir),
    item('review'),
    true,
    () => {
      agentCalls += 1;
      throw new Error('agent must not run');
    },
  );

  expect(result).toEqual({
    lines: [`PR #${ISSUE_NUMBER}: approval no longer present; skipped`],
    ranCodex: false,
  });
  expect(calls.every(({ method }) => method === 'GET')).toBe(true);
  expect(agentCalls).toBe(0);
});
