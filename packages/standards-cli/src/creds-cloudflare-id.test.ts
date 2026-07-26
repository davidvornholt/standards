// The identifier shape is a precondition check: `creds revoke` and the zone
// resolver run it before any request so a typo becomes a precise message
// instead of a provider 404, which is indistinguishable from a resource that
// exists but is out of reach. Both directions matter — accepting a near-miss
// sends the mistake to the provider, rejecting a valid ID blocks the command.

import { describe, expect, it } from 'bun:test';
import { isCloudflareId } from './creds-cloudflare-id';

const ID_LENGTH = 32;
const HEX = 'a'.repeat(ID_LENGTH);

describe('cloudflare identifier shape', () => {
  it('accepts exactly 32 lowercase hexadecimal characters', () => {
    expect(isCloudflareId(HEX)).toBe(true);
    expect(isCloudflareId('0123456789abcdef'.repeat(2))).toBe(true);
  });

  it('rejects the near misses a mistyped identifier takes', () => {
    expect(isCloudflareId('a'.repeat(ID_LENGTH - 1))).toBe(false);
    expect(isCloudflareId('a'.repeat(ID_LENGTH + 1))).toBe(false);
    expect(isCloudflareId(HEX.toUpperCase())).toBe(false);
    expect(isCloudflareId(`${'a'.repeat(ID_LENGTH - 1)}g`)).toBe(false);
    expect(isCloudflareId(`prefix ${HEX} suffix`)).toBe(false);
    expect(isCloudflareId(`${HEX}\n`)).toBe(false);
    expect(isCloudflareId('dns-token-from-2023')).toBe(false);
  });
});
