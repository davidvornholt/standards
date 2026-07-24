import { afterEach, describe, expect, it } from 'bun:test';
import { HTTP_CREATED } from './github-api';
import { type ApiCall, installApi } from './github-commands-test-support';
import type { ApprovalBinding } from './poller-approval';
import { acquireClaim } from './poller-claim';

const originalFetch = globalThis.fetch;
const malformedPrimitiveNumber = 42;
const validMarkerId = 20;
const context = {
  token: 'token',
  repo: 'owner/repo',
  issueNumber: 7,
};
const approval: ApprovalBinding = {
  id: 'approval',
  repo: context.repo,
  issueNumber: context.issueNumber,
  eventId: 100,
  label: 'approved-for-fix',
  actorLogin: 'maintainer',
  approvedAt: '2026-07-18T11:00:00Z',
  target: 'issue:revision',
};
const claimFields = {
  claimLabel: 'fix-in-progress',
  claimEpoch: '101',
  nonce: 'nonce',
};
const createdAt = (value: string): Record<string, string> =>
  Object.fromEntries([['created_at', value]]);
const labeled = {
  id: 101,
  event: 'labeled',
  label: { name: 'fix-in-progress' },
  actor: { login: 'maintainer' },
  ...createdAt('2026-07-18T12:00:00Z'),
};
const markerBody = (
  format: 'hidden' | 'legacy',
  markerApproval: unknown,
): string => {
  const payload = JSON.stringify({
    approval: markerApproval,
    ...claimFields,
  });
  return format === 'hidden'
    ? `<!-- standards-poller:claim\n${payload}\n-->`
    : `<!-- standards-poller:claim -->\n${payload}`;
};
const comment = (id: number, body: string, authorLogin: string): unknown => ({
  id,
  body,
  user: { login: authorLogin },
  ...createdAt('2026-07-18T12:00:01Z'),
});
const incompleteApprovals = Object.keys(approval).map(
  (omittedKey) =>
    [
      `object missing ${omittedKey}`,
      Object.fromEntries(
        Object.entries(approval).filter(([key]) => key !== omittedKey),
      ),
    ] as const,
);
const malformedApprovals: ReadonlyArray<readonly [string, unknown]> = [
  ['null', null],
  ['string', 'approval'],
  ['number', malformedPrimitiveNumber],
  ['boolean', false],
  ...incompleteApprovals,
];

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe.each([
  'hidden',
  'legacy',
] as const)('%s claim marker approval parsing', (format) => {
  it.each(
    malformedApprovals,
  )('ignores a malformed %s approval and elects the valid marker', async (_description, malformedApproval) => {
    const calls: ReadonlyArray<ApiCall> = installApi([
      { body: [labeled] },
      { status: HTTP_CREATED, body: { id: validMarkerId } },
      {
        body: [
          comment(10, markerBody(format, malformedApproval), 'untrusted-user'),
          comment(validMarkerId, markerBody(format, approval), 'maintainer'),
        ],
      },
      {
        body: Object.fromEntries([['role_name', 'maintain']]),
      },
    ]);

    await expect(
      acquireClaim(context, approval, 'fix-in-progress'),
    ).resolves.toMatchObject({ markerId: validMarkerId });
    expect(
      calls.filter((call) => call.path.includes('/collaborators/')),
    ).toHaveLength(1);
  });
});
