import { describe, expect, it } from 'bun:test';
import type { CloudflareToken } from './creds-cloudflare-api';
import { findDueTokens } from './creds-watch-due';

const NOW = new Date('2026-11-16T00:00:00Z');

const minted = (
  repo: string,
  key: string,
  expiresOn: string | null,
  extra: Partial<CloudflareToken> = {},
): CloudflareToken => ({
  id: `id-${repo}-${key}-${expiresOn ?? 'never'}`,
  name: `standards/${repo}/ci/${key}`,
  status: 'active',
  expiresOn,
  issuedOn: null,
  policies: [],
  condition: { supported: true, value: null },
  ...extra,
});

const at = (accountId: string, token: CloudflareToken) => ({
  accountId,
  token,
});

describe('creds watch due tokens', () => {
  it('reports tokens within 30 days and expired ones, grouped by repository', () => {
    const report = findDueTokens(
      [
        at('a', minted('owner/zeta', 'ci.late', '2026-12-10T00:00:00Z')),
        at('a', minted('owner/zeta', 'ci.early', '2026-12-01T00:00:00Z')),
        at(
          'b',
          minted('Owner/Alpha', 'ci.gone', '2026-11-01T00:00:00Z', {
            status: 'expired',
          }),
        ),
        at('a', minted('owner/far', 'ci.far', '2027-06-01T00:00:00Z')),
        at('a', { ...minted('owner/x', 'ci.k', null), name: 'hand-made' }),
      ],
      NOW,
    );
    expect(report.problems).toEqual([]);
    expect([...report.byRepo.keys()]).toEqual(['owner/alpha', 'owner/zeta']);
    expect(report.byRepo.get('owner/alpha')).toEqual([
      {
        accountId: 'b',
        tokenId: 'id-Owner/Alpha-ci.gone-2026-11-01T00:00:00Z',
        name: 'standards/Owner/Alpha/ci/ci.gone',
        repo: 'owner/alpha',
        expiresOn: '2026-11-01T00:00:00.000Z',
        expired: true,
      },
    ]);
    expect(
      report.byRepo.get('owner/zeta')?.map(({ name, expired }) => ({
        name,
        expired,
      })),
    ).toEqual([
      { name: 'standards/owner/zeta/ci/ci.early', expired: false },
      { name: 'standards/owner/zeta/ci/ci.late', expired: false },
    ]);
  });

  it('keeps reporting a due token while a same-name token in the same account is active past the window', () => {
    // An interrupted renewal leaves both tokens active, and the expiring one
    // may still be the one in use, so it stays due until it is retired.
    const report = findDueTokens(
      [
        at('a', minted('owner/r', 'ci.k', '2026-11-20T00:00:00Z')),
        at('a', minted('owner/r', 'ci.k', '2027-11-20T00:00:00Z')),
      ],
      NOW,
    );
    expect(
      report.byRepo.get('owner/r')?.map(({ accountId, name, expiresOn }) => ({
        accountId,
        name,
        expiresOn,
      })),
    ).toEqual([
      {
        accountId: 'a',
        name: 'standards/owner/r/ci/ci.k',
        expiresOn: '2026-11-20T00:00:00.000Z',
      },
    ]);
  });

  it('reports case-distinct keys independently', () => {
    const report = findDueTokens(
      [
        at('a', minted('owner/r', 'ci.TOKEN', '2026-11-20T00:00:00Z')),
        at('a', minted('owner/r', 'ci.token', '2026-11-25T00:00:00Z')),
        at('a', minted('owner/r', 'ci.token', '2027-11-20T00:00:00Z')),
      ],
      NOW,
    );
    expect(report.byRepo.get('owner/r')?.map(({ name }) => name)).toEqual([
      'standards/owner/r/ci/ci.TOKEN',
      'standards/owner/r/ci/ci.token',
    ]);
  });

  it('ignores disabled and non-expiring tokens and reports an expired token without a valid expiry', () => {
    const report = findDueTokens(
      [
        at(
          'a',
          minted('owner/r', 'ci.off', '2026-11-20T00:00:00Z', {
            status: 'disabled',
          }),
        ),
        at('a', minted('owner/r', 'ci.never', null)),
        at('a', minted('owner/r', 'ci.broken', null, { status: 'expired' })),
        at('a', minted('owner/r', 'ci.bad', 'not-a-date')),
      ],
      NOW,
    );
    expect(report.byRepo.size).toBe(0);
    expect(report.problems).toEqual([
      expect.stringContaining('standards/owner/r/ci/ci.broken'),
      expect.stringContaining('standards/owner/r/ci/ci.bad'),
    ]);
  });
});
