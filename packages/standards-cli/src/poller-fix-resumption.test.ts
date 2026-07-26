import { afterEach, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { installPollerApi } from './poller-api-test-support';
import { issueRevision } from './poller-approval';
import { parsePollerConfig } from './poller-config';
import { sealFixOutput } from './poller-fix-output';
import { runFixJob } from './poller-fix-run';
import type { IssueItem } from './poller-github';
import {
  checkout,
  commitFile,
  createLocalPollerRepo,
  createTestApproval,
  pushRef,
} from './poller-job-run-test-support';
import { branchNameForIssue } from './poller-protocol';
import { failGitHubRequestOnce } from './poller-transient-failure-test-support';

const originalFetch = globalThis.fetch;
const REPO = 'owner/repo';
const ISSUE_NUMBER = 7;
const roots: Array<string> = [];

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

it('releases a failed sealed fix publication for the next tick', async () => {
  const fixture = createLocalPollerRepo();
  roots.push(fixture.root);
  const item: IssueItem = {
    number: ISSUE_NUMBER,
    title: 'Title',
    body: 'Body',
    isPullRequest: false,
    labels: ['approved-for-fix'],
    authorLogin: 'reporter',
  };
  const binding = createTestApproval('approved-for-fix', issueRevision(item));
  checkout(fixture.source, fixture.baseSha);
  commitFile(fixture.source, 'fixed.txt', 'fixed\n');
  const sealed = sealFixOutput(fixture.source, {
    repo: REPO,
    issueNumber: ISSUE_NUMBER,
    approvalId: binding.id,
    title: 'fix(poller): recover output',
    body: `Use \`<!--\` literally.\n\nFixes #${ISSUE_NUMBER}`,
    baseSha: fixture.baseSha,
    commits: 1,
  });
  pushRef(
    fixture.source,
    branchNameForIssue(ISSUE_NUMBER, binding.id),
    sealed.sealedHead,
  );
  const failedCalls = installPollerApi({
    baseSha: fixture.baseSha,
    headSha: fixture.headSha,
    isPullRequest: false,
  });
  failGitHubRequestOnce('POST', '/pulls');

  await expect(
    runFixJob(
      deps(fixture.cacheDir),
      item,
      () => Promise.resolve('main'),
      false,
    ),
  ).rejects.toThrow('create draft PR');
  expect(
    failedCalls.some(
      (call) =>
        call.method === 'DELETE' &&
        call.path.endsWith('/labels/fix-in-progress'),
    ),
  ).toBe(true);

  installPollerApi({
    baseSha: fixture.baseSha,
    headSha: fixture.headSha,
    isPullRequest: false,
  });
  await expect(
    runFixJob(
      deps(fixture.cacheDir),
      item,
      () => Promise.resolve('main'),
      false,
    ),
  ).resolves.toEqual({
    lines: [`#${ISSUE_NUMBER}: opened draft PR #44`],
    ranCodex: false,
  });
});

it('rejects non-operative closing text before publishing resumed output', async () => {
  const fixture = createLocalPollerRepo();
  roots.push(fixture.root);
  const item: IssueItem = {
    number: ISSUE_NUMBER,
    title: 'Title',
    body: 'Body',
    isPullRequest: false,
    labels: ['approved-for-fix'],
    authorLogin: 'reporter',
  };
  const binding = createTestApproval('approved-for-fix', issueRevision(item));
  checkout(fixture.source, fixture.baseSha);
  commitFile(fixture.source, 'fixed.txt', 'fixed\n');
  const sealed = sealFixOutput(fixture.source, {
    repo: REPO,
    issueNumber: ISSUE_NUMBER,
    approvalId: binding.id,
    title: 'fix(poller): recover output',
    body: `<!--\nFixes #${ISSUE_NUMBER}\n-->`,
    baseSha: fixture.baseSha,
    commits: 1,
  });
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

  await expect(
    runFixJob(
      deps(fixture.cacheDir),
      item,
      () => Promise.resolve('main'),
      false,
    ),
  ).rejects.toThrow('sealed fix output does not match this job');
  expect(
    calls.some(
      (call) =>
        (call.method === 'POST' || call.method === 'PATCH') &&
        call.path.includes('/pulls'),
    ),
  ).toBe(false);
  expect(
    calls.some(
      (call) =>
        call.method === 'DELETE' &&
        call.path.endsWith('/labels/fix-in-progress'),
    ),
  ).toBe(true);
});
