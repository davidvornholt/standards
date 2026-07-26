// Proving that a stored secret matches the value that was just minted, without
// that value reaching a return type, a log line, or an error message. Callers
// destroy the new credential on a proven mismatch and keep it on an
// unverifiable read, so the two negative answers must stay distinct: anything
// that is not a leaf we can read as a scalar string is unverifiable.

import { isContainedSopsPath, parseSopsKeyPath } from './creds-sops-structure';
import { runSops } from './sops-exec';

export type SopsStoredValueVerification =
  | { readonly ok: true; readonly matches: boolean }
  | { readonly ok: false; readonly problem: string };
type SopsStoredValueInput = {
  readonly consumer: string;
  readonly rel: string;
  readonly dottedPath: string;
  readonly expectedValue: string;
};

// Extracting a scalar leaf prints the stored value itself, with no quoting and
// no framing of any kind — probed against sops 3.13.0. Every byte of stdout is
// therefore value, which makes exact equality the only sound comparison: a
// trailing newline is a difference in the stored secret, not output framing.
//
// Output that parses as JSON but is not a string cannot be a scalar leaf, so
// the extraction resolved to a branch or the read returned something other than
// the value. That is unverifiable rather than a mismatch. A stored value the
// comparison above already rejected can reach this too — a differing number, say
// — and unverifiable is the safe reading of it, because the alternative deletes
// a credential on a guess.
const readScalarLeaf = (stdout: string): string | null => {
  if (stdout === '') {
    return null;
  }
  try {
    return typeof JSON.parse(stdout) === 'string' ? stdout : null;
  } catch {
    // Not JSON at all, which is the normal case: an opaque token value, or a
    // hex access key ID that reads as a malformed number.
    return stdout;
  }
};

export const verifySopsStoredValueWith = (
  runner: typeof runSops,
  input: SopsStoredValueInput,
): SopsStoredValueVerification => {
  const { consumer, rel, dottedPath, expectedValue } = input;
  const path = parseSopsKeyPath(dottedPath);
  const problem = `could not verify stored SOPS value at ${dottedPath} in ${rel}`;
  if (path === null || !isContainedSopsPath(consumer, rel, 'file')) {
    return { ok: false, problem };
  }
  const extract = path
    .map((segment) => `[${JSON.stringify(segment)}]`)
    .join('');
  const result = runner(
    ['decrypt', '--extract', extract, '--output-type', 'json', rel],
    consumer,
  );
  if (result.status !== 0) {
    return { ok: false, problem };
  }
  if (result.stdout === expectedValue) {
    return { ok: true, matches: true };
  }
  return readScalarLeaf(result.stdout) === null
    ? { ok: false, problem }
    : { ok: true, matches: false };
};

export const verifySopsStoredValue = (
  consumer: string,
  rel: string,
  dottedPath: string,
  expectedValue: string,
): SopsStoredValueVerification =>
  verifySopsStoredValueWith(runSops, {
    consumer,
    rel,
    dottedPath,
    expectedValue,
  });
