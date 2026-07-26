import { describe, expect, it } from 'bun:test';
import {
  BROKER_IDENTITY_NAME,
  isInMintedNamespace,
  parseAnyTokenName,
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

  // `creds revoke` holds no repository, so this is the only thing standing
  // between "another repository reconciles this token" and deleting it. A name
  // it resolves is refused without --force; a name it does not is deleted, so
  // both answers are load-bearing in opposite directions.
  it('resolves the owning repository of a minted name, and nothing else', () => {
    expect(parseAnyTokenName('standards/other/repo/ci/ci.dns_token')).toEqual({
      repo: 'other/repo',
      target: 'ci',
      key: 'ci.dns_token',
    });
    expect(parseAnyTokenName('standards/other/repo/ci')).toBeNull();
    expect(parseAnyTokenName('standards/only-owner')).toBeNull();
    expect(parseAnyTokenName(BROKER_IDENTITY_NAME)).toBeNull();
    expect(parseAnyTokenName('dns-token-from-2023')).toBeNull();
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
