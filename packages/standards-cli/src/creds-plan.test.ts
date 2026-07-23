import { describe, expect, it } from 'bun:test';
import type { CloudflareToken } from './creds-cloudflare-api';
import { computeCredsPlan } from './creds-plan';

const REPO = 'davidvornholt/example';
const NOW = new Date('2026-07-22T00:00:00Z');

const token = (name: string, expiresOn: string | null): CloudflareToken => ({
  id: `id-${name}`,
  name,
  status: 'active',
  expiresOn,
  policies: undefined,
});

const keys = (
  entries: Readonly<Record<string, ReadonlyArray<string>>>,
): ReadonlyMap<string, ReadonlySet<string>> =>
  new Map(
    Object.entries(entries).map(([target, list]) => [target, new Set(list)]),
  );

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

  it('rolls a token entering the renewal window, keyed to its SOPS destination', () => {
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
        kind: 'roll',
        target: 'ci',
        key: 'ci.dns_token',
      }),
    ]);
  });

  it('does not roll a non-expiring healthy token', () => {
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
