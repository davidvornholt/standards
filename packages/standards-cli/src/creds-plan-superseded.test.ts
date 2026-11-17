// A renewal renames the token it replaced `<name> (superseded)` and lets it
// expire within a week, so the running host keeps working until its deploy
// (standards#565). These pin how plan and watch read that name: never as an
// ambiguous duplicate of the stored token, never as due for renewal.

import { describe, expect, it } from 'bun:test';
import type { CloudflareToken } from './creds-cloudflare-api';
import {
  parseAnyTokenName,
  supersededNameOf,
  supersededOriginalName,
} from './creds-naming';
import { computeCredsPlan } from './creds-plan';
import { keys, NOW, REPO, token } from './creds-plan-test-support';
import { findDueTokens } from './creds-watch-due';

const NAME = `standards/${REPO}/ci/ci.dns_token`;
const SUPERSEDED = supersededNameOf(NAME);
const DAY_MS = 86_400_000;

const at = (entry: CloudflareToken) => ({ accountId: 'a', token: entry });

const plan = (tokens: ReadonlyArray<CloudflareToken>) =>
  computeCredsPlan({
    repo: REPO,
    keysByTarget: keys({ ci: ['ci.dns_token'] }),
    tokens: tokens.map(at),
    now: NOW,
  });

const renewAction = (expiresOn: string, status = 'active') => {
  const [action] = plan([{ ...token(NAME, expiresOn), status }]).actions;
  return action?.kind === 'renew' ? action : null;
};

describe('superseded token names', () => {
  it('round-trips the original name and never parses as a minted one', () => {
    expect(supersededOriginalName(SUPERSEDED)).toBe(NAME);
    expect(supersededOriginalName(NAME)).toBeNull();
    expect(parseAnyTokenName(SUPERSEDED)).toBeNull();
  });
});

describe('creds plan with a superseded token', () => {
  it('keeps the stored token healthy beside its superseded predecessor', () => {
    const result = plan([
      token(NAME, '2027-07-22T00:00:00Z'),
      token(SUPERSEDED, '2026-07-29T00:00:00Z'),
    ]);
    expect(result.findings).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(result.healthy).toBe(1);
    expect(result.unmanaged).toEqual([]);
    expect(result.superseded).toEqual([
      {
        accountId: 'a',
        tokenId: `id-${SUPERSEDED}`,
        name: SUPERSEDED,
        status: 'active',
        expiresOn: '2026-07-29T00:00:00Z',
      },
    ]);
  });

  it('ignores an expired superseded token and another repository superseded one', () => {
    const result = plan([
      { ...token(SUPERSEDED, '2026-07-01T00:00:00Z'), status: 'expired' },
      token(supersededNameOf('standards/other/repo/ci/ci.key'), null),
    ]);
    expect(result).toEqual({
      actions: [],
      findings: [],
      healthy: 0,
      unmanaged: [],
      brokeredElsewhere: [],
      superseded: [],
    });
  });

  it('still reports a malformed name in this repository namespace', () => {
    const result = plan([token(`standards/${REPO}/ci (superseded)`, null)]);
    expect(result.findings).toEqual([
      expect.stringContaining("claims this repository's brokered namespace"),
    ]);
  });
});

describe('creds plan superseded expiry', () => {
  it('shortens the old token to a week from now', () => {
    expect(renewAction('2026-08-15T00:00:00Z')?.supersededExpiresOn).toBe(
      new Date(NOW.getTime() + 7 * DAY_MS).toISOString().replace('.000Z', 'Z'),
    );
  });

  it('never lengthens an old token that expires sooner', () => {
    expect(renewAction('2026-07-25T00:00:00Z')?.supersededExpiresOn).toBe(
      '2026-07-25T00:00:00Z',
    );
  });

  it('deletes rather than keeps an old token that already expired', () => {
    expect(
      renewAction('2026-07-21T00:00:00Z', 'expired')?.supersededExpiresOn,
    ).toBeNull();
    expect(renewAction('2026-07-21T00:00:00Z')?.supersededExpiresOn).toBeNull();
  });
});

describe('creds watch with a superseded token', () => {
  it('does not report a superseded token as due', () => {
    const report = findDueTokens(
      [
        at(token(NAME, '2027-07-22T00:00:00Z')),
        at(token(SUPERSEDED, '2026-07-29T00:00:00Z')),
      ],
      NOW,
    );
    expect(report.problems).toEqual([]);
    expect([...report.byRepo.keys()]).toEqual([]);
  });
});
