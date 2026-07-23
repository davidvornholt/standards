import { afterEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { HTTP_CREATED } from './github-api';
import { installApi } from './github-commands-test-support';
import type { PollerConfig } from './poller-config';
import { failJob, jobPreamble, releaseLabels } from './poller-job-shared';
import { QUESTION_MARKER } from './poller-protocol';

const originalFetch = globalThis.fetch;
const config = {} as PollerConfig;
const ISSUE_NUMBER = 8;
const OLD_FAILURE_SNIPPET_LIMIT = 1500;
const FAILURE_CONTEXT_LINE_COUNT = 50;
const createdAt = (value: string): Record<string, string> =>
  Object.fromEntries([['created_at', value]]);
const role = (value: string) => ({
  body: Object.fromEntries([['role_name', value]]),
});
const deps = {
  config,
  token: 'token',
  repo: 'owner/repo',
  roleCache: new Map(),
};
const labels = {
  approved: 'approved-for-fix',
  inProgress: 'fix-in-progress',
  failed: 'fix-failed',
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.GH_TOKEN = undefined;
});

describe('jobPreamble', () => {
  it('repairs a missing waiting label and never runs past an unanswered question', async () => {
    const item = {
      number: 8,
      labels: ['approved-for-fix'],
    };
    installApi([
      {
        body: {
          number: 8,
          title: 'title',
          body: 'body',
          labels: [{ name: 'approved-for-fix' }],
          user: { login: 'reporter' },
        },
      },
      {
        body: [
          {
            id: 101,
            event: 'labeled',
            label: { name: 'approved-for-fix' },
            actor: { login: 'maintainer' },
            ...createdAt('2026-07-18T10:00:00Z'),
          },
        ],
      },
      role('admin'),
      {
        body: [
          {
            id: 1,
            body: `${QUESTION_MARKER}\nChoose an owner`,
            user: { login: 'maintainer' },
            ...createdAt('2026-07-18T11:00:00Z'),
          },
        ],
      },
      role('admin'),
      { body: {} }, // add needs-clarification
      { body: {} }, // remove absent in-progress
    ]);
    const result = await jobPreamble(
      {
        config,
        token: 'token',
        repo: 'owner/repo',
        roleCache: new Map(),
      },
      item,
      {
        approved: 'approved-for-fix',
        inProgress: 'fix-in-progress',
        failed: 'fix-failed',
      },
      'issue:approved',
    );
    expect(result).toEqual({ kind: 'waiting' });
  });

  it('requires the label repair write to succeed', () => {
    installApi([
      {
        body: {
          number: 8,
          title: 'title',
          body: 'body',
          labels: [{ name: 'approved-for-fix' }],
          user: { login: 'reporter' },
        },
      },
      {
        body: [
          {
            id: 102,
            event: 'labeled',
            label: { name: 'approved-for-fix' },
            actor: { login: 'maintainer' },
            ...createdAt('2026-07-18T10:00:00Z'),
          },
        ],
      },
      role('admin'),
      {
        body: [
          {
            id: 1,
            body: `${QUESTION_MARKER}\nChoose an owner`,
            user: { login: 'maintainer' },
            ...createdAt('2026-07-18T11:00:00Z'),
          },
        ],
      },
      role('admin'),
      { status: HTTP_CREATED, body: {} },
    ]);
    expect(
      jobPreamble(
        {
          config,
          token: 'token',
          repo: 'owner/repo',
          roleCache: new Map(),
        },
        { number: 8, labels: ['approved-for-fix'] },
        {
          approved: 'approved-for-fix',
          inProgress: 'fix-in-progress',
          failed: 'fix-failed',
        },
        'issue:approved',
      ),
    ).rejects.toThrow('add needs-clarification');
  });
});

describe('failJob', () => {
  it('preserves actionable diagnostics beyond the old comment limit', async () => {
    const actionableMarker = 'ACTION REQUIRED: upgrade the Codex CLI';
    const failure = `codex exec failed (exit status 1):\n${'stderr: worker initialization failed\n'.repeat(FAILURE_CONTEXT_LINE_COUNT)}${actionableMarker}`;
    expect(failure.length).toBeGreaterThan(OLD_FAILURE_SNIPPET_LIMIT);
    expect(failure.indexOf(actionableMarker)).toBeGreaterThan(
      OLD_FAILURE_SNIPPET_LIMIT,
    );
    const calls = installApi([
      { status: HTTP_CREATED, body: { id: 1 } },
      { body: {} },
      { body: {} },
      { body: {} },
    ]);

    await failJob(deps, labels, ISSUE_NUMBER, failure);

    expect(calls[0]?.body).toEqual({
      body: expect.stringContaining(actionableMarker),
    });
    expect(calls[0]?.body).toEqual({
      body: expect.stringContaining(
        'Re-apply `approved-for-fix` after addressing this to retry.',
      ),
    });
  });
});

describe('releaseLabels', () => {
  it('removes approval last so cleanup failures remain schedulable', async () => {
    const calls = installApi([{ body: {} }, { body: {} }, { body: {} }]);
    await releaseLabels(deps, labels, ISSUE_NUMBER);
    expect(calls.map((call) => call.path)).toEqual([
      '/repos/owner/repo/issues/8/labels/fix-in-progress',
      '/repos/owner/repo/issues/8/labels/fix-failed',
      '/repos/owner/repo/issues/8/labels/approved-for-fix',
    ]);
  });
});
