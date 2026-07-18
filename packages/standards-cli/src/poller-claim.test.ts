import { afterEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { HTTP_CREATED, HTTP_OK } from './github-api';
import { type ApiCall, installApi } from './github-commands-test-support';
import { issueRevision, readApprovalBinding } from './poller-approval';
import { acquireClaim, validateClaim } from './poller-claim';
import type { IssueItem } from './poller-github';

const originalFetch = globalThis.fetch;
const issueNumber = 7;
const issue = (labels: ReadonlyArray<string>): IssueItem => ({
  number: issueNumber,
  title: 'Fix the poller',
  body: 'Exact approved body',
  isPullRequest: false,
  labels,
  authorLogin: 'reporter',
});
const rawIssue = (labels: ReadonlyArray<string>): unknown => ({
  number: issueNumber,
  title: 'Fix the poller',
  body: 'Exact approved body',
  labels: labels.map((name) => ({ name })),
  user: { login: 'reporter' },
});
const createdAt = (value: string): Record<string, string> =>
  Object.fromEntries([['created_at', value]]);
const role = (value: string) => ({
  body: Object.fromEntries([['role_name', value]]),
});
const labeled = (label: string, actor = 'maintainer'): unknown => ({
  id: 101,
  event: 'labeled',
  label: { name: label },
  actor: { login: actor },
  ...createdAt('2026-07-18T12:00:00Z'),
});
const context = {
  token: 'token',
  repo: 'owner/repo',
  issueNumber,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.GH_TOKEN = undefined;
});

describe('approval and claim bindings', () => {
  it('elects the earliest trusted marker for one claim epoch', async () => {
    const approval = {
      id: 'approval',
      repo: context.repo,
      issueNumber,
      eventId: 100,
      label: 'approved-for-fix',
      actorLogin: 'maintainer',
      approvedAt: '2026-07-18T11:00:00Z',
      target: issueRevision(issue(['approved-for-fix'])),
    };
    const earlierMarker = {
      id: 10,
      body: `<!-- standards-poller:claim -->\n${JSON.stringify({
        approval,
        claimLabel: 'fix-in-progress',
        claimEpoch: '101',
        nonce: 'earlier',
      })}`,
      user: { login: 'maintainer' },
      ...createdAt('2026-07-18T12:00:01Z'),
    };
    installApi([
      { body: [labeled('fix-in-progress')] },
      { status: HTTP_CREATED, body: { id: 11 } },
      {
        body: [
          earlierMarker,
          {
            ...earlierMarker,
            id: 11,
            body: earlierMarker.body.replace('earlier', 'ours'),
          },
        ],
      },
      role('maintain'),
      role('maintain'),
    ]);

    expect(await acquireClaim(context, approval, 'fix-in-progress')).toBeNull();
  });

  it('rejects approval removal, content edits, and role revocation', async () => {
    installApi([
      { body: rawIssue(['approved-for-fix']) },
      { body: [labeled('approved-for-fix')] },
      role('admin'),
    ]);
    const approval = await readApprovalBinding(
      context,
      'approved-for-fix',
      issueRevision(issue(['approved-for-fix'])),
    );
    if (typeof approval === 'string') {
      throw new Error(approval);
    }
    const claim = {
      approval,
      claimLabel: 'fix-in-progress',
      claimEpoch: '2026-07-18T12:00:00Z',
      markerId: 4,
    };

    installApi([{ body: rawIssue(['fix-in-progress']) }]);
    expect(await validateClaim(context, claim, approval.target)).toContain(
      'not currently present',
    );

    installApi([
      { body: rawIssue(['approved-for-fix', 'fix-in-progress']) },
      { body: [labeled('approved-for-fix')] },
      role('admin'),
    ]);
    expect(await validateClaim(context, claim, 'issue:changed')).toContain(
      'exact approved revision/head',
    );

    installApi([
      { body: rawIssue(['approved-for-fix', 'fix-in-progress']) },
      { body: [labeled('approved-for-fix')] },
      role('write'),
    ]);
    expect(await validateClaim(context, claim, approval.target)).toContain(
      'only admin or maintain',
    );
  });

  it('reads current label presence before trusting a historical event', async () => {
    const calls: ReadonlyArray<ApiCall> = installApi([
      { status: HTTP_OK, body: rawIssue([]) },
    ]);
    expect(
      await readApprovalBinding(
        context,
        'approved-for-fix',
        issueRevision(issue([])),
      ),
    ).toContain('not currently present');
    expect(calls).toHaveLength(1);
  });

  it('matches approval and timeline label identity without regard to case', async () => {
    installApi([
      { body: rawIssue(['Approved-For-Fix']) },
      { body: [labeled('APPROVED-FOR-FIX')] },
      role('maintain'),
    ]);
    const approval = await readApprovalBinding(
      context,
      'approved-for-fix',
      'issue:revision',
    );
    expect(typeof approval).not.toBe('string');
  });
});

it('distinguishes same-second approval generations by timeline event ID', async () => {
  installApi([
    { body: rawIssue(['approved-for-fix']) },
    { body: [labeled('approved-for-fix')] },
    role('maintain'),
  ]);
  const first = await readApprovalBinding(
    context,
    'approved-for-fix',
    'issue:revision',
  );
  installApi([
    { body: rawIssue(['approved-for-fix']) },
    {
      body: [
        {
          ...(labeled('approved-for-fix') as Record<string, unknown>),
          id: 102,
        },
      ],
    },
    role('maintain'),
  ]);
  const second = await readApprovalBinding(
    context,
    'approved-for-fix',
    'issue:revision',
  );
  if (typeof first === 'string' || typeof second === 'string') {
    throw new Error('test approvals must be valid');
  }
  expect(first.approvedAt).toBe(second.approvedAt);
  expect(first.id).not.toBe(second.id);
});
