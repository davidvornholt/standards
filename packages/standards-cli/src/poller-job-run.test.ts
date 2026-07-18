import { afterEach, describe, expect, it } from 'bun:test';
import { HTTP_CREATED } from './github-api';
import { installApi } from './github-commands-test-support';
import { parsePollerConfig } from './poller-config';
import { runFixJob } from './poller-fix-run';
import type { IssueItem } from './poller-github';
import { runReviewJob } from './poller-review-run';

const originalFetch = globalThis.fetch;
const ISSUE_NUMBER = 7;
const configResult = parsePollerConfig(
  {
    repos: ['owner/repo'],
    model: 'gpt-test',
    reasoningEffort: 'high',
  },
  '/tmp',
);
if (configResult.config === null) {
  throw new Error('test config must parse');
}
const deps = {
  config: configResult.config,
  token: 'token',
  repo: 'owner/repo',
  roleCache: new Map(),
};
const item: IssueItem = {
  number: ISSUE_NUMBER,
  title: 'Title',
  body: 'Body',
  isPullRequest: false,
  labels: ['approved-for-fix'],
  authorLogin: 'reporter',
};
const rawIssue = (label: string) => ({
  number: ISSUE_NUMBER,
  title: 'Title',
  body: 'Body',
  labels: [{ name: label }],
  user: { login: 'reporter' },
});
const timeline = (label: string) => ({
  body: [
    {
      event: 'labeled',
      label: { name: label },
      actor: { login: 'maintainer' },
      ...Object.fromEntries([['created_at', '2026-07-18T10:00:00Z']]),
    },
  ],
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('poller job entrypoints', () => {
  it('runFixJob rejects an untrusted approval before workspace or Codex work', async () => {
    installApi([
      { body: rawIssue('Approved-For-Fix') },
      { body: rawIssue('Approved-For-Fix') },
      timeline('APPROVED-FOR-FIX'),
      { body: Object.fromEntries([['role_name', 'write']]) },
      { body: {} },
      { status: HTTP_CREATED, body: { id: 1 } },
    ]);
    await expect(runFixJob(deps, item, 'main')).resolves.toEqual({
      lines: [`#${ISSUE_NUMBER}: approval rejected`],
      ranCodex: false,
    });
  });

  it('runReviewJob rejects a non-draft PR before workspace or Codex work', async () => {
    installApi([
      {
        body: {
          ...Object.fromEntries([['node_id', 'PR_node']]),
          title: 'Title',
          body: 'Body',
          draft: false,
          head: {
            ref: 'feature',
            sha: 'head',
            repo: Object.fromEntries([['full_name', 'owner/repo']]),
          },
          base: { ref: 'main', sha: 'base' },
        },
      },
      { body: [] }, // no durable review plan
      { body: rawIssue('Approved-For-Review') },
      { body: rawIssue('Approved-For-Review') },
      timeline('APPROVED-FOR-REVIEW'),
      { body: Object.fromEntries([['role_name', 'maintain']]) },
      { body: [] }, // no prior question
      { status: HTTP_CREATED, body: { id: 1 } },
      { body: {} },
      { body: {} },
      { body: {} },
    ]);
    await expect(
      runReviewJob(deps, {
        ...item,
        isPullRequest: true,
        labels: ['approved-for-review'],
      }),
    ).resolves.toEqual({
      lines: [`PR #${ISSUE_NUMBER}: rejected (not draft)`],
      ranCodex: false,
    });
  });
});
