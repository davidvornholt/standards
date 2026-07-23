import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySopsStoredValueWith } from './creds-sops';
import type { SopsRunResult } from './sops-exec';

const calls: Array<{
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}> = [];
let runResult: SopsRunResult = {
  status: 0,
  stdout: JSON.stringify('secret-value'),
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
    stdout: JSON.stringify('secret-value'),
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

  it('proves a mismatch without exposing either value', () => {
    const consumer = fixture();
    runResult = { ...runResult, stdout: JSON.stringify('different-value') };
    expect(
      verifySopsStoredValue(
        consumer,
        'secrets/ci.yaml',
        'ci.token',
        'expected-value',
      ),
    ).toEqual({ ok: true, matches: false });
  });

  it('reports decrypt and parse failures as unverifiable', () => {
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

    runResult = { ...runResult, status: 0, stdout: 'not-json' };
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
