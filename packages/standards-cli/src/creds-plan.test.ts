import { describe, expect, it } from 'bun:test';
import { computeCredsPlan } from './creds-plan';
import { keys, NOW, POLICIES, REPO, token } from './creds-plan-test-support';

describe('creds plan computation', () => {
  it('leaves healthy brokered tokens and all foreign tokens alone', () => {
    const plan = computeCredsPlan({
      repo: REPO,
      keysByTarget: keys({ ci: ['ci.dns_token'] }),
      tokens: [
        {
          accountId: 'a',
          token: token(
            `standards/${REPO}/ci/ci.dns_token`,
            '2027-01-01T00:00:00Z',
          ),
        },
        { accountId: 'a', token: token('hand-made-token', null) },
        {
          accountId: 'a',
          token: token(
            'standards/other/repo/ci/ci.dns_token',
            '2026-08-01T00:00:00Z',
          ),
        },
      ],
      now: NOW,
    });
    expect(plan.actions).toEqual([]);
    expect(plan.findings).toEqual([]);
    expect(plan.healthy).toBe(1);
  });

  it('revokes a brokered token whose secret key vanished from SOPS', () => {
    const plan = computeCredsPlan({
      repo: REPO,
      keysByTarget: keys({ ci: ['ci.other_key'] }),
      tokens: [
        {
          accountId: 'a',
          token: token(
            `standards/${REPO}/ci/ci.dns_token`,
            '2027-01-01T00:00:00Z',
          ),
        },
      ],
      now: NOW,
    });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]?.kind).toBe('revoke');
  });

  it('revokes when the whole target file is gone', () => {
    const plan = computeCredsPlan({
      repo: REPO,
      keysByTarget: keys({}),
      tokens: [
        {
          accountId: 'a',
          token: token(`standards/${REPO}/prod-1/apps.web.r2`, null),
        },
      ],
      now: NOW,
    });
    expect(plan.actions[0]?.kind).toBe('revoke');
  });

  it('renews with copied policies and a fresh lifetime', () => {
    const plan = computeCredsPlan({
      repo: REPO,
      keysByTarget: keys({ ci: ['ci.dns_token'] }),
      tokens: [
        {
          accountId: 'a',
          token: token(
            `standards/${REPO}/ci/ci.dns_token`,
            '2026-08-01T00:00:00Z',
          ),
        },
      ],
      now: NOW,
    });
    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: 'renew',
        target: 'ci',
        key: 'ci.dns_token',
        format: 'bearer',
        policies: POLICIES,
        replacementExpiresOn: '2026-10-20T00:00:00Z',
      }),
    ]);
  });

  it('does not renew a non-expiring healthy token', () => {
    const plan = computeCredsPlan({
      repo: REPO,
      keysByTarget: keys({ ci: ['ci.dns_token'] }),
      tokens: [
        {
          accountId: 'a',
          token: token(`standards/${REPO}/ci/ci.dns_token`, null),
        },
      ],
      now: NOW,
    });
    expect(plan.actions).toEqual([]);
    expect(plan.healthy).toBe(1);
  });
});

describe('creds plan safeguards', () => {
  it('surfaces non-active tokens instead of counting or mutating them', () => {
    const inactive = {
      ...token(`standards/${REPO}/ci/ci.dns_token`, '2027-01-01T00:00:00Z'),
      status: 'disabled',
    };
    const plan = computeCredsPlan({
      repo: REPO,
      keysByTarget: keys({ ci: ['ci.dns_token'] }),
      tokens: [{ accountId: 'a', token: inactive }],
      now: NOW,
    });
    expect(plan.actions).toEqual([]);
    expect(plan.healthy).toBe(0);
    expect(plan.findings).toEqual([expect.stringContaining('status disabled')]);
  });

  it('fails closed on duplicate destinations across accounts', () => {
    const name = `standards/${REPO}/ci/ci.dns_token`;
    const plan = computeCredsPlan({
      repo: REPO,
      keysByTarget: keys({ ci: ['ci.dns_token'] }),
      tokens: [
        { accountId: 'a', token: token(name, '2027-01-01T00:00:00Z') },
        {
          accountId: 'b',
          token: { ...token(name, '2027-01-01T00:00:00Z'), id: 'other' },
        },
      ],
      now: NOW,
    });
    expect(plan.actions).toEqual([]);
    expect(plan.healthy).toBe(0);
    expect(plan.findings).toEqual([
      expect.stringContaining('ambiguous Cloudflare tokens'),
    ]);
  });

  it('refuses renewal when live policy data is unavailable', () => {
    const expiring = {
      ...token(`standards/${REPO}/ci/ci.dns_token`, '2026-08-01T00:00:00Z'),
      policies: null,
    };
    const plan = computeCredsPlan({
      repo: REPO,
      keysByTarget: keys({ ci: ['ci.dns_token'] }),
      tokens: [{ accountId: 'a', token: expiring }],
      now: NOW,
    });
    expect(plan.actions).toEqual([]);
    expect(plan.findings).toEqual([
      expect.stringContaining('cannot be renewed safely'),
    ]);
  });
});
