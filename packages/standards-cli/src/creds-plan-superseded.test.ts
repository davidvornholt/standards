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
  it('keeps the expiry the old token already had', () => {
    expect(renewAction('2026-08-15T00:00:00Z')?.supersededExpiresOn).toBe(
      '2026-08-15T00:00:00Z',
    );
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

describe('creds plan with a superseded token whose destination is gone', () => {
  const withdrawn = (tokens: ReadonlyArray<CloudflareToken>) =>
    computeCredsPlan({
      repo: REPO,
      keysByTarget: keys({ ci: [] }),
      tokens: tokens.map(at),
      now: NOW,
    });

  it('revokes the superseded token together with the current one', () => {
    const result = withdrawn([
      token(NAME, '2027-07-22T00:00:00Z'),
      token(SUPERSEDED, '2026-08-12T00:00:00Z'),
    ]);
    expect(result.actions).toEqual([
      {
        kind: 'revoke',
        accountId: 'a',
        tokenId: `id-${NAME}`,
        name: NAME,
        reason: 'secret ci:ci.dns_token no longer exists',
      },
      {
        kind: 'revoke',
        accountId: 'a',
        tokenId: `id-${SUPERSEDED}`,
        name: SUPERSEDED,
        reason: 'secret ci:ci.dns_token no longer exists',
      },
    ]);
    expect(result.superseded).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it('revokes a superseded token left without a current one', () => {
    const result = withdrawn([token(SUPERSEDED, '2026-08-12T00:00:00Z')]);
    expect(result.actions.map((action) => action.tokenId)).toEqual([
      `id-${SUPERSEDED}`,
    ]);
    expect(result.superseded).toEqual([]);
  });

  it('keeps a superseded S3 pair bridging while both keys exist and revokes it once both are gone', () => {
    const s3Name = `standards/${REPO}/ci/ci.bucket`;
    const old = token(supersededNameOf(s3Name), '2026-08-12T00:00:00Z');
    const bridged = computeCredsPlan({
      repo: REPO,
      keysByTarget: keys({
        ci: ['ci.bucket.access_key_id', 'ci.bucket.secret_access_key'],
      }),
      tokens: [at(old)],
      now: NOW,
    });
    expect(bridged.actions).toEqual([]);
    expect(bridged.superseded.map((entry) => entry.tokenId)).toEqual([old.id]);
    expect(
      withdrawn([old]).actions.map((action) => [action.kind, action.tokenId]),
    ).toEqual([['revoke', old.id]]);
  });

  it('leaves a superseded token that is not active to the report', () => {
    const result = withdrawn([
      { ...token(SUPERSEDED, '2026-08-12T00:00:00Z'), status: 'disabled' },
    ]);
    expect(result.actions).toEqual([]);
    expect(result.superseded.map((entry) => entry.status)).toEqual([
      'disabled',
    ]);
  });
});
