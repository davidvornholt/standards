import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { HTTP_CREATED } from './github-api';
import {
  type ApiCall,
  installApi,
  installNetworkFailure,
} from './github-commands-test-support';
import { type PollerConfig, parsePollerConfig } from './poller-config';
import { runPollerTick } from './poller-tick';

const originalFetch = globalThis.fetch;
const NOW = Date.parse('2026-07-18T12:00:00Z');
const STALE_ISSUE = 5;
const FRESH_ISSUE = 6;
const CLAIMED_ISSUE = 7;
const REJECTED_ISSUE = 9;

const config = (): PollerConfig => {
  const parsed = parsePollerConfig(
    {
      repos: ['owner/repo'],
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    },
    '/tmp',
  );
  if (parsed.config === null) {
    throw new Error('test config must parse');
  }
  return parsed.config;
};

beforeEach(() => {
  process.env.GH_TOKEN = 'test-token';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.GH_TOKEN = undefined;
});

const issue = (
  number: number,
  labels: ReadonlyArray<string>,
): Readonly<Record<string, unknown>> => ({
  number,
  title: `issue ${number}`,
  body: 'body',
  labels: labels.map((name) => ({ name })),
  user: { login: 'reporter' },
});

describe('runPollerTick', () => {
  it('completes quietly when nothing is labeled', async () => {
    installApi([
      { body: [] }, // fix-in-progress sweep
      { body: [] }, // review-in-progress sweep
      { body: [] }, // review-approved
      { body: [] }, // approved-for-fix
    ]);
    const report = await runPollerTick(config(), 'test-token', NOW);
    expect(report.problems).toEqual([]);
    expect(report.lines).toEqual([]);
  });

  it('releases a stale claim and leaves fresh claims alone', async () => {
    const calls: ReadonlyArray<ApiCall> = installApi([
      {
        body: [
          issue(STALE_ISSUE, ['fix-in-progress']),
          issue(FRESH_ISSUE, ['fix-in-progress']),
        ],
      },
      {
        body: [
          {
            event: 'labeled',
            label: { name: 'fix-in-progress' },
            actor: { login: 'poller' },
            created_at: '2026-07-18T02:00:00Z', // 10h old: stale
          },
        ],
      },
      { body: {} }, // DELETE stale label
      { status: HTTP_CREATED, body: {} }, // POST release comment
      {
        body: [
          {
            event: 'labeled',
            label: { name: 'fix-in-progress' },
            actor: { login: 'poller' },
            created_at: '2026-07-18T11:00:00Z', // 1h old: fresh
          },
        ],
      },
      { body: [] }, // review-in-progress sweep
      { body: [] }, // review-approved
      { body: [] }, // approved-for-fix
    ]);
    const report = await runPollerTick(config(), 'test-token', NOW);
    expect(report.problems).toEqual([]);
    expect(report.lines).toEqual([
      'owner/repo#5: released stale fix-in-progress',
    ]);
    const mutations = calls.filter((call) => call.method !== 'GET');
    expect(mutations.map((call) => `${call.method} ${call.path}`)).toEqual([
      'DELETE /repos/owner/repo/issues/5/labels/fix-in-progress',
      'POST /repos/owner/repo/issues/5/comments',
    ]);
  });

  it('rejects an approval applied by an untrusted actor without running a job', async () => {
    const calls: ReadonlyArray<ApiCall> = installApi([
      { body: [] }, // fix-in-progress sweep
      { body: [] }, // review-in-progress sweep
      { body: [] }, // review-approved
      { body: [issue(REJECTED_ISSUE, ['approved-for-fix'])] },
      { body: { default_branch: 'main' } },
      {
        body: [
          {
            event: 'labeled',
            label: { name: 'approved-for-fix' },
            actor: { login: 'drive-by' },
            created_at: '2026-07-18T11:30:00Z',
          },
        ],
      },
      { body: { role_name: 'write' } },
      { body: {} }, // DELETE approved-for-fix
      { status: HTTP_CREATED, body: {} }, // POST explanation comment
    ]);
    const report = await runPollerTick(config(), 'test-token', NOW);
    expect(report.problems).toEqual([]);
    expect(report.lines).toEqual(['owner/repo #9: approval rejected']);
    const deletes = calls.filter((call) => call.method === 'DELETE');
    expect(deletes.map((call) => call.path)).toEqual([
      '/repos/owner/repo/issues/9/labels/approved-for-fix',
    ]);
  });

  it('skips items whose claim label is still held', async () => {
    installApi([
      { body: [issue(CLAIMED_ISSUE, ['approved-for-fix', 'fix-in-progress'])] },
      {
        body: [
          {
            event: 'labeled',
            label: { name: 'fix-in-progress' },
            actor: { login: 'poller' },
            created_at: '2026-07-18T11:00:00Z', // fresh claim
          },
        ],
      },
      { body: [] }, // review-in-progress sweep
      { body: [] }, // review-approved
      { body: [issue(CLAIMED_ISSUE, ['approved-for-fix', 'fix-in-progress'])] },
    ]);
    const report = await runPollerTick(config(), 'test-token', NOW);
    expect(report.problems).toEqual([]);
    expect(report.lines).toEqual([]);
  });

  it('fails closed per repository when the API is unreachable', async () => {
    installNetworkFailure();
    const report = await runPollerTick(config(), 'test-token', NOW);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('owner/repo');
  });
});
