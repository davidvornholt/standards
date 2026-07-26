import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  cleanupStoredValueFixtures,
  sopsCalls,
  verifyStoredValue,
} from './creds-sops-value-test-support';

afterEach(cleanupStoredValueFixtures);

describe('stored SOPS value verification', () => {
  it('proves a match without returning or logging the secret', () => {
    const log = spyOn(console, 'log');
    const error = spyOn(console, 'error');
    const { result, consumer } = verifyStoredValue({
      stdout: 'secret-value',
      expectedValue: 'secret-value',
      dottedPath: 'ci.deploy_app.private_key',
    });

    expect(result).toEqual({ ok: true, matches: true });
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(sopsCalls).toEqual([
      {
        args: [
          'decrypt',
          '--extract',
          '["ci"]["deploy_app"]["private_key"]',
          '--output-type',
          'json',
          'secrets/ci.yaml',
        ],
        cwd: consumer,
      },
    ]);
  });

  // The R2 access key ID that surfaced this: 32 hex characters starting with a
  // digit, which JSON.parse rejects as a malformed number. Reading that as
  // unverifiable told operators to re-mint a credential that was stored
  // correctly.
  it('proves a match for a raw scalar that is not valid JSON', () => {
    const accessKeyId = '9f3a1c7d0b52e84a6d1f0c93be27a5d4';
    expect(
      verifyStoredValue({
        stdout: accessKeyId,
        expectedValue: accessKeyId,
        dottedPath: 'ci.tofu_state.access_key_id',
      }).result,
    ).toEqual({ ok: true, matches: true });
  });

  // Equality is decided before the output is classified. Were that order
  // reversed, this value would read as a JSON number rather than as the bytes
  // it is, and every all-digit secret would become unverifiable.
  it('proves a match for a scalar whose own text is valid JSON', () => {
    expect(
      verifyStoredValue({ stdout: '123456', expectedValue: '123456' }).result,
    ).toEqual({ ok: true, matches: true });
  });

  it('proves a match for a value carrying its own newline', () => {
    expect(
      verifyStoredValue({
        stdout: 'line-one\nline-two\n',
        expectedValue: 'line-one\nline-two\n',
        dottedPath: 'ci.deploy_app.private_key',
      }).result,
    ).toEqual({ ok: true, matches: true });
  });
});

describe('stored SOPS value rejection', () => {
  it('proves a mismatch without exposing either value', () => {
    expect(
      verifyStoredValue({
        stdout: 'different-value',
        expectedValue: 'expected-value',
      }).result,
    ).toEqual({ ok: true, matches: false });
  });

  // sops adds no framing, so a trailing newline belongs to the stored secret.
  // Accepting it would certify a destination holding something other than the
  // minted value — and at creds-plan-renew.ts that destination is then rewritten
  // as if its ownership had been proven.
  it('counts a trailing newline as a difference in the stored value', () => {
    expect(
      verifyStoredValue({
        stdout: 'secret-value\n',
        expectedValue: 'secret-value',
      }).result,
    ).toEqual({ ok: true, matches: false });
  });

  it('proves a mismatch for a differing quoted value', () => {
    expect(
      verifyStoredValue({
        stdout: JSON.stringify('other-value'),
        expectedValue: 'secret-value',
      }).result,
    ).toEqual({ ok: true, matches: false });
  });
});
