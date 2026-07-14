import { describe, expect, it } from 'bun:test';
import { identitiesMatch, type NodeIdentity } from './sync-filesystem';
import {
  parseStoredNodeIdentity,
  storedNodeIdentity,
} from './sync-node-identity';

const ABOVE_SAFE = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
const DISTINCT_OFFSET = 101n;

describe('exact filesystem identities', () => {
  it('round-trips decimal identities above Number.MAX_SAFE_INTEGER', () => {
    const identity: NodeIdentity = {
      dev: ABOVE_SAFE,
      ino: ABOVE_SAFE + DISTINCT_OFFSET,
    };
    const stored = storedNodeIdentity(identity);

    expect(stored).toEqual({
      dev: '9007199254740992',
      ino: '9007199254741093',
    });
    expect(parseStoredNodeIdentity(stored, 'identity')).toEqual(identity);
  });

  it('does not collapse adjacent identities above the safe-number limit', () => {
    expect(
      identitiesMatch(
        { dev: ABOVE_SAFE, ino: ABOVE_SAFE },
        { dev: ABOVE_SAFE, ino: ABOVE_SAFE + 1n },
      ),
    ).toBe(false);
  });

  it('accepts only explicitly enabled safe legacy numbers', () => {
    expect(
      parseStoredNodeIdentity(
        { dev: 1, ino: Number.MAX_SAFE_INTEGER },
        'legacy',
        { allowLegacyNumber: true },
      ),
    ).toEqual({ dev: 1n, ino: BigInt(Number.MAX_SAFE_INTEGER) });
    expect(() =>
      parseStoredNodeIdentity(
        { dev: 1, ino: Number.MAX_SAFE_INTEGER + 1 },
        'legacy',
        { allowLegacyNumber: true },
      ),
    ).toThrow('canonical decimal filesystem identity');
    expect(() =>
      parseStoredNodeIdentity({ dev: 1, ino: 2 }, 'current'),
    ).toThrow('canonical decimal filesystem identity');
  });
});
