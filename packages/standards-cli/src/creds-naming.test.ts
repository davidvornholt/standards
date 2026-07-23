import { describe, expect, it } from 'bun:test';
import {
  BROKER_IDENTITY_NAME,
  isInMintedNamespace,
  parseTokenName,
  repoTokenPrefix,
  tokenNameOf,
} from './creds-naming';

const REPO = 'davidvornholt/example';

describe('creds token naming', () => {
  it('round-trips a token reference through its provider-side name', () => {
    const ref = { repo: REPO, target: 'ci', key: 'ci.cloudflare_dns_token' };
    const name = tokenNameOf(ref);
    expect(name).toBe(
      'standards/davidvornholt/example/ci/ci.cloudflare_dns_token',
    );
    expect(parseTokenName(name, REPO)).toEqual(ref);
  });

  it('round-trips host targets and nested keys', () => {
    const ref = { repo: REPO, target: 'prod-1', key: 'apps.web.r2_token' };
    expect(parseTokenName(tokenNameOf(ref), REPO)).toEqual(ref);
  });

  it('never parses tokens of other repos or foreign naming schemes', () => {
    expect(parseTokenName('standards/other/repo/ci/key', REPO)).toBeNull();
    expect(parseTokenName('my-hand-made-token', REPO)).toBeNull();
    expect(
      parseTokenName(`${repoTokenPrefix(REPO)}only-target`, REPO),
    ).toBeNull();
    expect(parseTokenName(`${repoTokenPrefix(REPO)}ci/`, REPO)).toBeNull();
  });

  it('keeps the broker identity name outside the minted namespace', () => {
    expect(isInMintedNamespace(BROKER_IDENTITY_NAME)).toBe(false);
    expect(
      isInMintedNamespace(
        tokenNameOf({ repo: REPO, target: 'ci', key: 'a.b' }),
      ),
    ).toBe(true);
    expect(isInMintedNamespace('standards-broker-2')).toBe(false);
    expect(isInMintedNamespace('standards/anything')).toBe(true);
  });

  it('rejects unsafe segments instead of minting ambiguous names', () => {
    expect(() =>
      tokenNameOf({ repo: REPO, target: 'ci', key: 'a..b' }),
    ).toThrow('invalid secret key');
    expect(() =>
      tokenNameOf({ repo: REPO, target: '../ci', key: 'a' }),
    ).toThrow('invalid secrets target');
    expect(() =>
      tokenNameOf({ repo: 'no-owner', target: 'ci', key: 'a' }),
    ).toThrow('invalid repository');
  });
});
