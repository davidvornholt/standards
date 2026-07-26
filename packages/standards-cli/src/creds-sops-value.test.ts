import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySopsStoredValueWith } from './creds-sops-value';
import type { SopsRunResult } from './sops-exec';

const calls: Array<{
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}> = [];
// sops prints an extracted scalar leaf raw, so that — not a JSON document — is
// what the runner returns by default here.
let runResult: SopsRunResult = {
  status: 0,
  stdout: 'secret-value',
  stderr: '',
  errorMessage: null,
};

const verifySopsStoredValue = (
  consumer: string,
  rel: string,
  dottedPath: string,
  expectedValue: string,
) =>
  verifySopsStoredValueWith(
    (args: ReadonlyArray<string>, cwd: string): SopsRunResult => {
      calls.push({ args, cwd });
      return runResult;
    },
    { consumer, rel, dottedPath, expectedValue },
  );
const dirs: Array<string> = [];

const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'creds-sops-value-'));
  dirs.push(root);
  const consumer = join(root, 'consumer');
  mkdirSync(join(consumer, 'secrets'), { recursive: true });
  writeFileSync(join(consumer, 'secrets', 'ci.yaml'), 'sops: {}\n');
  return consumer;
};

afterEach(() => {
  calls.length = 0;
  runResult = {
    status: 0,
    stdout: 'secret-value',
    stderr: '',
    errorMessage: null,
  };
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('stored SOPS value verification', () => {
  it('proves a match without returning or logging the secret', () => {
    const consumer = fixture();
    const secret = 'secret-value';
    const log = spyOn(console, 'log');
    const error = spyOn(console, 'error');

    expect(
      verifySopsStoredValue(
        consumer,
        'secrets/ci.yaml',
        'ci.deploy_app.private_key',
        secret,
      ),
    ).toEqual({ ok: true, matches: true });
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(calls).toEqual([
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
    const consumer = fixture();
    const accessKeyId = '9f3a1c7d0b52e84a6d1f0c93be27a5d4';
    runResult = { ...runResult, stdout: accessKeyId };
    expect(
      verifySopsStoredValue(
        consumer,
        'secrets/ci.yaml',
        'ci.tofu_state.access_key_id',
        accessKeyId,
      ),
    ).toEqual({ ok: true, matches: true });
  });

  it('treats the trailing newline as framing rather than value', () => {
    const consumer = fixture();
    runResult = { ...runResult, stdout: 'secret-value\n' };
    expect(
      verifySopsStoredValue(
        consumer,
        'secrets/ci.yaml',
        'ci.token',
        'secret-value',
      ),
    ).toEqual({ ok: true, matches: true });
  });

  it('still proves a match when sops quotes the scalar as JSON', () => {
    const consumer = fixture();
    runResult = { ...runResult, stdout: JSON.stringify('secret-value') };
    expect(
      verifySopsStoredValue(
        consumer,
        'secrets/ci.yaml',
        'ci.token',
        'secret-value',
      ),
    ).toEqual({ ok: true, matches: true });
  });
});

describe('stored SOPS value rejection', () => {
  it('proves a mismatch without exposing either value', () => {
    const consumer = fixture();
    runResult = { ...runResult, stdout: 'different-value' };
    expect(
      verifySopsStoredValue(
        consumer,
        'secrets/ci.yaml',
        'ci.token',
        'expected-value',
      ),
    ).toEqual({ ok: true, matches: false });
  });

  // Callers delete the token they just created on a mismatch, so a read that
  // answered nothing must stay unverifiable and leave that decision alone.
  it('reports a failed decrypt and an empty read as unverifiable', () => {
    const consumer = fixture();
    runResult = { ...runResult, status: 1 };
    const failed = verifySopsStoredValue(
      consumer,
      'secrets/ci.yaml',
      'ci.token',
      'expected-value',
    );
    expect(failed).toEqual({
      ok: false,
      problem:
        'could not verify stored SOPS value at ci.token in secrets/ci.yaml',
    });

    runResult = { ...runResult, status: 0, stdout: '' };
    expect(
      verifySopsStoredValue(
        consumer,
        'secrets/ci.yaml',
        'ci.token',
        'expected-value',
      ),
    ).toEqual(failed);
  });
});
