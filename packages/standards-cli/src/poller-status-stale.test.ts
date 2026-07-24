import { afterEach, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { installApi } from './github-commands-test-support';
import type { ApprovalBinding } from './poller-approval';
import type { PollerConfig } from './poller-config';
import type { PollerJobKind } from './poller-queue-marker';
import { acknowledgeQueuedJob } from './poller-status';

const originalFetch = globalThis.fetch;
const REPO = 'owner/repo';
const ISSUE_NUMBER = 7;

const approval = (kind: PollerJobKind): ApprovalBinding => {
  const fields = {
    repo: REPO,
    issueNumber: ISSUE_NUMBER,
    eventId: 101,
    label: `approved-for-${kind}`,
    actorLogin: 'maintainer',
    approvedAt: '2026-07-18T10:00:00Z',
    target: `${kind}:target`,
  };
  return {
    id: createHash('sha256').update(JSON.stringify(fields)).digest('hex'),
    ...fields,
  };
};

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

it.each([
  'fix',
  'review',
] as const)('keeps repeated stale %s acknowledgements write-free', async (kind) => {
  const calls = installApi([{ body: staleIssue }, { body: staleIssue }]);
  const deps = {
    config: {} as PollerConfig,
    token: 'token',
    repo: REPO,
    roleCache: new Map(),
  };

  await expect(
    acknowledgeQueuedJob(deps, ISSUE_NUMBER, approval(kind), kind),
  ).resolves.toBe(false);
  await expect(
    acknowledgeQueuedJob(deps, ISSUE_NUMBER, approval(kind), kind),
  ).resolves.toBe(false);

  expect(calls).toHaveLength(2);
  expect(calls.every(({ method }) => method === 'GET')).toBe(true);
});
