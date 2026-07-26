// Callers destroy the credential they just minted on a proven mismatch and keep
// it on an unverifiable read, so every output that cannot be read as the leaf's
// own value has to land here rather than in the mismatch branch.

import { afterEach, describe, expect, it } from 'bun:test';
import type { SopsStoredValueVerification } from './creds-sops-value';
import {
  cleanupStoredValueFixtures,
  UNVERIFIABLE_PROBLEM,
  verifyStoredValue,
} from './creds-sops-value-test-support';

afterEach(cleanupStoredValueFixtures);

const unverifiable: SopsStoredValueVerification = {
  ok: false,
  problem: UNVERIFIABLE_PROBLEM,
};

describe('stored SOPS value unverifiability', () => {
  it('reports a failed decrypt as unverifiable', () => {
    expect(
      verifyStoredValue({
        stdout: 'secret-value',
        expectedValue: 'expected-value',
        status: 1,
      }).result,
    ).toEqual(unverifiable);
  });

  it('reports an empty read as unverifiable', () => {
    expect(
      verifyStoredValue({ stdout: '', expectedValue: 'expected-value' }).result,
    ).toEqual(unverifiable);
  });

  // An extraction that resolved to a branch or a typed leaf never read the
  // value, so it proves nothing either way. Real sops indents branches and ends
  // them with a newline, which must not change that answer.
  it.each([
    [
      'an object',
      '{\n\t"access_key_id": "a",\n\t"secret_access_key": "b"\n}\n',
    ],
    ['a list', '[\n\t"a",\n\t"b"\n]'],
    ['null', 'null'],
    ['a number', '123'],
    ['a boolean', 'true'],
  ])('reports %s extraction as unverifiable', (_label, stdout) => {
    expect(
      verifyStoredValue({ stdout, expectedValue: 'expected-value' }).result,
    ).toEqual(unverifiable);
  });

  // Quoted output holding exactly the expected value has two explanations that
  // the bytes cannot tell apart: stray quotes in storage, or framing from a sops
  // we have not probed. Calling it a mismatch would delete a credential on that
  // guess.
  it('reports a quoted rendering of the expected value as unverifiable', () => {
    expect(
      verifyStoredValue({
        stdout: JSON.stringify('secret-value'),
        expectedValue: 'secret-value',
      }).result,
    ).toEqual(unverifiable);
  });
});
