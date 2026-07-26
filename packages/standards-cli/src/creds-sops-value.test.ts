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

  it('proves a match for a value carrying its own newline', () => {
    const consumer = fixture();
    runResult = { ...runResult, stdout: 'line-one\nline-two' };
    expect(
      verifySopsStoredValue(
        consumer,
        'secrets/ci.yaml',
        'ci.deploy_app.private_key',
        'line-one\nline-two',
      ),
    ).toEqual({ ok: true, matches: true });
  });
});

describe('stored SOPS value rejection', () => {
  const mismatch = (stdout: string, expectedValue: string) => {
    const consumer = fixture();
    runResult = { ...runResult, stdout };
    return verifySopsStoredValue(
      consumer,
      'secrets/ci.yaml',
      'ci.token',
      expectedValue,
    );
  };

  it('proves a mismatch without exposing either value', () => {
    expect(mismatch('different-value', 'expected-value')).toEqual({
      ok: true,
      matches: false,
    });
  });

  // sops adds no framing, so a trailing newline belongs to the stored secret.
  // Accepting it would certify a destination holding something other than the
  // minted value — and at creds-plan-renew.ts that destination is then rewritten
  // as if its ownership had been proven.
  it('counts a trailing newline as a difference in the stored value', () => {
    expect(mismatch('secret-value\n', 'secret-value')).toEqual({
      ok: true,
      matches: false,
    });
  });

  // Stray quoting around a secret is the storage corruption this check exists
  // to catch, so the quotes are part of the value rather than JSON syntax.
  it('counts literal quotes around the value as a difference', () => {
    expect(mismatch(JSON.stringify('secret-value'), 'secret-value')).toEqual({
      ok: true,
      matches: false,
    });
  });
});

// Callers delete the token they just created on a mismatch, so every read that
// failed to produce a scalar leaf must stay unverifiable and leave the
// credential alone.
describe('stored SOPS value unverifiability', () => {
  const problem =
    'could not verify stored SOPS value at ci.token in secrets/ci.yaml';

  const unverifiable = (stdout: string, status = 0) => {
    const consumer = fixture();
    runResult = { ...runResult, status, stdout };
    return verifySopsStoredValue(
      consumer,
      'secrets/ci.yaml',
      'ci.token',
      'expected-value',
    );
  };

  it('reports a failed decrypt as unverifiable', () => {
    expect(unverifiable('secret-value', 1)).toEqual({ ok: false, problem });
  });

  it('reports a read that answered nothing as unverifiable', () => {
    expect(unverifiable('')).toEqual({ ok: false, problem });
  });

  // An extraction that resolved to a branch, a list, or any other non-string
  // never read the value at all, so it proves nothing either way.
  it.each([
    ['an object', '{"access_key_id":"a","secret_access_key":"b"}'],
    ['a list', '["a","b"]'],
    ['null', 'null'],
    ['a number', '123'],
    ['a boolean', 'true'],
  ])('reports %s extraction as unverifiable', (_label, stdout) => {
    expect(unverifiable(stdout)).toEqual({ ok: false, problem });
  });
});
