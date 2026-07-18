import { afterEach, expect, it } from 'bun:test';
import { installApi } from './github-commands-test-support';
import { parsePollerConfig } from './poller-config';
import { runPollerTick } from './poller-tick';

const originalFetch = globalThis.fetch;
const NOW = Date.parse('2026-07-18T12:00:00Z');

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const issue = (
  number: number,
  label: string,
  pullRequest: boolean,
): Readonly<Record<string, unknown>> => ({
  number,
  title: `issue ${number}`,
  body: 'body',
  labels: [{ name: label }],
  user: { login: 'reporter' },
  ...(pullRequest ? Object.fromEntries([['pull_request', { url: 'x' }]]) : {}),
});

const timeline = (label: string, createdAt: string) => ({
  body: [
    {
      event: 'labeled',
      label: { name: label },
      actor: { login: 'maintainer' },
      ...Object.fromEntries([['created_at', createdAt]]),
    },
  ],
});

it('schedules every repository review before an earlier repository fix', async () => {
  const parsed = parsePollerConfig(
    {
      repos: ['owner/repo-a', 'owner/repo-b'],
      model: 'gpt-test',
      reasoningEffort: 'high',
    },
    '/tmp',
  );
  if (parsed.config === null) {
    throw new Error('test config must parse');
  }
  installApi([
    { body: [] }, // repo-a fix sweep
    { body: [] }, // repo-a review sweep
    { body: [] }, // repo-a reviews
    { body: [issue(1, 'approved-for-fix', false)] },
    timeline('approved-for-fix', '2026-07-18T10:00:00Z'),
    { body: [] }, // repo-b fix sweep
    { body: [] }, // repo-b review sweep
    { body: [issue(2, 'Approved-For-Review', true)] },
    { body: [] }, // repo-b fixes
    timeline('APPROVED-FOR-REVIEW', '2026-07-18T11:00:00Z'),
  ]);
  const ran: Array<string> = [];
  const report = await runPollerTick(parsed.config, 'test-token', NOW, {
    review: (_deps, item) => {
      ran.push(`review:${item.number}`);
      return Promise.resolve({ lines: ['reviewed'], ranCodex: true });
    },
    fix: (_deps, item) => {
      ran.push(`fix:${item.number}`);
      return Promise.resolve({ lines: ['fixed'], ranCodex: true });
    },
  });
  expect(ran).toEqual(['review:2']);
  expect(report.problems).toEqual([]);
  expect(report.lines).toContain(
    'global: run cap reached; remaining jobs wait',
  );
});
