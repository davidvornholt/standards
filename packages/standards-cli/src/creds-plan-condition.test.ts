import { describe, expect, it } from 'bun:test';
import type { CloudflareToken } from './creds-cloudflare-api';
import { decodeTokenCondition } from './creds-cloudflare-condition';
import { computeCredsPlan } from './creds-plan';

const token = (condition: CloudflareToken['condition']): CloudflareToken => ({
  id: 'old',
  name: 'standards/davidvornholt/example/ci/ci.token',
  status: 'active',
  expiresOn: '2026-08-01T00:00:00Z',
  issuedOn: '2026-05-03T00:00:00Z',
  policies: [
    {
      effect: 'allow',
      resources: { 'com.cloudflare.api.account.a': '*' },
      // biome-ignore lint/style/useNamingConvention: Cloudflare's policy field is snake_case.
      permission_groups: [{ id: 'pg' }],
    },
  ],
  condition,
});

describe('Cloudflare renewal condition planning', () => {
  it('preserves supported request IP conditions in renewal actions', () => {
    const condition = {
      supported: true as const,
      value: {
        requestIp: {
          in: ['192.0.2.0/24'],
          notIn: ['192.0.2.10/32'],
        },
      },
    };
    const plan = computeCredsPlan({
      repo: 'davidvornholt/example',
      keysByTarget: new Map([['ci', new Set(['ci.token'])]]),
      tokens: [{ accountId: 'a', token: token(condition) }],
      now: new Date('2026-07-22T00:00:00Z'),
    });
    expect(plan.actions).toEqual([
      expect.objectContaining({ kind: 'renew', condition: condition.value }),
    ]);
  });

  it('reports unknown condition shapes without planning a mutation', () => {
    const decoded = decodeTokenCondition(
      JSON.parse('{"request_ip":{"future":[]}}') as unknown,
    );
    expect(decoded).toEqual({ supported: false });
    const plan = computeCredsPlan({
      repo: 'davidvornholt/example',
      keysByTarget: new Map([['ci', new Set(['ci.token'])]]),
      tokens: [
        {
          accountId: 'a',
          token: token(decoded),
        },
      ],
      now: new Date('2026-07-22T00:00:00Z'),
    });
    expect(plan.actions).toEqual([]);
    expect(plan.findings).toEqual([expect.stringContaining('condition')]);
  });

  it('revokes an absent key before validating its condition shape', () => {
    const plan = computeCredsPlan({
      repo: 'davidvornholt/example',
      keysByTarget: new Map([['ci', new Set(['ci.other'])]]),
      tokens: [
        {
          accountId: 'a',
          token: token({ supported: false }),
        },
      ],
      now: new Date('2026-07-22T00:00:00Z'),
    });
    expect(plan.actions).toEqual([
      expect.objectContaining({ kind: 'revoke', tokenId: 'old' }),
    ]);
    expect(plan.findings).toEqual([]);
  });
});
