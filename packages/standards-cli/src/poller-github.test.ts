import { afterEach, expect, it } from 'bun:test';
import { type ApiCall, installApi } from './github-commands-test-support';
import { listOpenIssuesWithLabel } from './poller-github';

const originalFetch = globalThis.fetch;
const STALE_ISSUE_NUMBER = 1;
const EXACT_LABEL_ISSUE_NUMBER = 2;
const CASE_VARIANT_ISSUE_NUMBER = 3;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const issue = (number: number, labels: ReadonlyArray<string>) => ({
  number,
  title: `Issue ${number}`,
  body: 'Body',
  labels: labels.map((name) => ({ name })),
  user: { login: 'reporter' },
});

it('discards stale label-filter results that do not carry the requested label', async () => {
  const calls: ReadonlyArray<ApiCall> = installApi([
    {
      body: [
        issue(STALE_ISSUE_NUMBER, []),
        issue(EXACT_LABEL_ISSUE_NUMBER, ['approved-for-fix']),
        issue(CASE_VARIANT_ISSUE_NUMBER, ['Approved-For-Fix']),
      ],
    },
  ]);

  const items = await listOpenIssuesWithLabel(
    'token',
    'owner/repo',
    'approved-for-fix',
  );

  expect(items.map(({ number }) => number)).toEqual([
    EXACT_LABEL_ISSUE_NUMBER,
    CASE_VARIANT_ISSUE_NUMBER,
  ]);
  expect(calls).toHaveLength(1);
});

it.each([
  ['missing', undefined],
  ['null', null],
  ['non-array', 'approved-for-fix'],
  ['missing name', [{}]],
  ['null name', [{ name: null }]],
  ['partially malformed', [{ name: 'approved-for-fix' }, null]],
] as const)('rejects a listing item with %s labels', async (_, labels) => {
  const raw = issue(STALE_ISSUE_NUMBER, []);
  const malformed =
    labels === undefined
      ? Object.fromEntries(
          Object.entries(raw).filter(([key]) => key !== 'labels'),
        )
      : { ...raw, labels };
  installApi([{ body: [malformed] }]);

  await expect(
    listOpenIssuesWithLabel('token', 'owner/repo', 'approved-for-fix'),
  ).rejects.toThrow(
    'list owner/repo issues labeled approved-for-fix: invalid issue at index 0',
  );
});
