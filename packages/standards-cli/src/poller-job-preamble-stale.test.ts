import { afterEach, expect, it } from 'bun:test';
import { HTTP_CREATED } from './github-api';
import { installApi } from './github-commands-test-support';
import type { PollerConfig } from './poller-config';
import { jobPreamble } from './poller-job-shared';

const originalFetch = globalThis.fetch;
const ISSUE_NUMBER = 8;
const REJECTED_EVENT_ID = 103;
const REPLACEMENT_EVENT_ID = 104;
const REPLACEMENT_READ_COUNT = 6;
const deps = {
  config: {} as PollerConfig,
  token: 'token',
  repo: 'owner/repo',
  roleCache: new Map(),
};
const labels = {
  approved: 'approved-for-fix',
  inProgress: 'fix-in-progress',
  failed: 'fix-failed',
};
const createdAt = (value: string): Record<string, string> =>
  Object.fromEntries([['created_at', value]]);
const role = (value: string) => ({
  body: Object.fromEntries([['role_name', value]]),
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it('silently skips a candidate whose approval label disappeared after discovery', async () => {
  const calls = installApi([
    {
      body: {
        number: ISSUE_NUMBER,
        title: 'title',
        body: 'body',
        labels: [],
        user: { login: 'reporter' },
      },
    },
  ]);

  const result = await jobPreamble(
    deps,
    { number: ISSUE_NUMBER, labels: ['approved-for-fix'] },
    labels,
    'issue:approved',
  );

  expect(result).toEqual({ kind: 'stale' });
  expect(calls).toHaveLength(1);
});

it('still rejects an approval label applied by an untrusted actor', async () => {
  const calls = installApi([
    {
      body: {
        number: ISSUE_NUMBER,
        title: 'title',
        body: 'body',
        labels: [{ name: 'approved-for-fix' }],
        user: { login: 'reporter' },
      },
    },
    {
      body: [
        {
          id: 103,
          event: 'labeled',
          label: { name: 'approved-for-fix' },
          actor: { login: 'contributor' },
          ...createdAt('2026-07-18T10:00:00Z'),
        },
      ],
    },
    role('write'),
    {
      body: {
        number: ISSUE_NUMBER,
        title: 'title',
        body: 'body',
        labels: [{ name: 'approved-for-fix' }],
        user: { login: 'reporter' },
      },
    },
    {
      body: [
        {
          id: 103,
          event: 'labeled',
          label: { name: 'approved-for-fix' },
          actor: { login: 'contributor' },
          ...createdAt('2026-07-18T10:00:00Z'),
        },
      ],
    },
    role('write'),
    { body: {} },
    { status: HTTP_CREATED, body: { id: 1 } },
  ]);

  const result = await jobPreamble(
    deps,
    { number: ISSUE_NUMBER, labels: ['approved-for-fix'] },
    labels,
    'issue:approved',
  );

  expect(result).toEqual({ kind: 'rejected' });
  expect(calls.map(({ method }) => method)).toEqual([
    'GET',
    'GET',
    'GET',
    'GET',
    'GET',
    'GET',
    'DELETE',
    'POST',
  ]);
});

it('does not clean up rejected approval A after trusted approval B replaces it', async () => {
  const issue = {
    number: ISSUE_NUMBER,
    title: 'title',
    body: 'body',
    labels: [{ name: 'approved-for-fix' }],
    user: { login: 'reporter' },
  };
  const event = (id: number, actor: string) => ({
    id,
    event: 'labeled',
    label: { name: 'approved-for-fix' },
    actor: { login: actor },
    ...createdAt('2026-07-18T10:00:00Z'),
  });
  const calls = installApi([
    { body: issue },
    { body: [event(REJECTED_EVENT_ID, 'contributor')] },
    role('write'),
    { body: issue },
    { body: [event(REPLACEMENT_EVENT_ID, 'maintainer')] },
    role('admin'),
  ]);

  const result = await jobPreamble(
    deps,
    { number: ISSUE_NUMBER, labels: ['approved-for-fix'] },
    labels,
    'issue:approved',
  );

  expect(result).toEqual({ kind: 'stale' });
  expect(calls).toHaveLength(REPLACEMENT_READ_COUNT);
  expect(calls.every(({ method }) => method === 'GET')).toBe(true);
});
