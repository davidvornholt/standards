// Shared harness for the stored-value verification tests: a throwaway consumer
// holding an encrypted target, and a stubbed sops whose stdout each case sets.
// The stubs print raw scalars because that is what sops prints for an extracted
// leaf — quoted stdout would model the bug these tests exist to prevent.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type SopsStoredValueVerification,
  verifySopsStoredValueWith,
} from './creds-sops-value';
import type { SopsRunResult } from './sops-exec';

export const UNVERIFIABLE_PROBLEM =
  'could not verify stored SOPS value at ci.token in secrets/ci.yaml';

export const sopsCalls: Array<{
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}> = [];

const dirs: Array<string> = [];

export const cleanupStoredValueFixtures = (): void => {
  sopsCalls.length = 0;
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const verifyStoredValue = (input: {
  readonly stdout: string;
  readonly expectedValue: string;
  readonly status?: number;
  readonly dottedPath?: string;
}): {
  readonly result: SopsStoredValueVerification;
  readonly consumer: string;
} => {
  const root = mkdtempSync(join(tmpdir(), 'creds-sops-value-'));
  dirs.push(root);
  const consumer = join(root, 'consumer');
  mkdirSync(join(consumer, 'secrets'), { recursive: true });
  writeFileSync(join(consumer, 'secrets', 'ci.yaml'), 'sops: {}\n');
  const result = verifySopsStoredValueWith(
    (args: ReadonlyArray<string>, cwd: string): SopsRunResult => {
      sopsCalls.push({ args, cwd });
      return {
        status: input.status ?? 0,
        stdout: input.stdout,
        stderr: '',
        errorMessage: null,
      };
    },
    {
      consumer,
      rel: 'secrets/ci.yaml',
      dottedPath: input.dottedPath ?? 'ci.token',
      expectedValue: input.expectedValue,
    },
  );
  return { result, consumer };
};
