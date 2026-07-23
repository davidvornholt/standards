import { describe, expect, it } from 'bun:test';
import { parseTtlDays } from './creds-args';

const DEFAULT_TTL_DAYS = 90;

describe('credential command parsing', () => {
  it('accepts complete provider-safe positive integer TTLs', () => {
    expect(parseTtlDays('1')).toBe(1);
    expect(parseTtlDays('90')).toBe(DEFAULT_TTL_DAYS);
  });

  it('rejects partial, non-positive, and overflowing TTL tokens', () => {
    const invalid = [
      '',
      '0',
      '-1',
      '1.5',
      '1e3',
      '90days',
      ' 90',
      '90 ',
      '+90',
      '01',
      '9007199254740992',
      '999999999999999999999999999999999999999999999999',
    ];
    for (const raw of invalid) {
      expect(() => parseTtlDays(raw)).toThrow('provider-safe positive integer');
    }
  });
});
