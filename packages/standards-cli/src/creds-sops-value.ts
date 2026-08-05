// Proving that a stored secret matches the value that was just minted, without
// that value reaching a return type, a log line, or an error message. Callers
// destroy the new credential on a proven mismatch and keep it on an
// unverifiable read, so the two negative answers must stay distinct: anything
// that is not a leaf we can read as a scalar string is unverifiable.

import { isContainedPath } from './contained-path';
import { parseSopsKeyPath } from './creds-sops-structure';
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
// no framing of any kind — probed against sops 3.13.0 and 3.13.3. Every byte of
// stdout is therefore value, which makes exact equality the only sound
// comparison: a trailing newline is a difference in the stored secret, not
// output framing.
//
// Once equality has been ruled out, output that parses as JSON is output we
// cannot read as this leaf's own value. It is a branch or list rather than a
// scalar; or a typed leaf, which a stored string could equally have produced;
// or a quoted rendering of exactly the value expected, which is either stray
// quoting in storage or framing from some sops we have not probed. None of
// those can be told apart from what was printed, and the wrong answer deletes a
// credential, so all of them stay unverifiable.
const isUnreadableOutput = (stdout: string, expectedValue: string): boolean => {
  if (stdout === '') {
    return true;
  }
  try {
    const parsed: unknown = JSON.parse(stdout);
    return typeof parsed !== 'string' || parsed === expectedValue;
  } catch {
    // Not JSON at all, which is the normal case: an opaque token value, or a
    // hex access key ID that reads as a malformed number.
    return false;
  }
};

export const verifySopsStoredValueWith = (
  runner: typeof runSops,
  input: SopsStoredValueInput,
): SopsStoredValueVerification => {
  const { consumer, rel, dottedPath, expectedValue } = input;
  const path = parseSopsKeyPath(dottedPath);
  const problem = `could not verify stored SOPS value at ${dottedPath} in ${rel}`;
  if (path === null || !isContainedPath(consumer, rel, 'file')) {
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
  // Equality is decided before anything is classified, so a secret whose own
  // text happens to be valid JSON — an all-digit token — is proven by the bytes
  // rather than second-guessed by their shape.
  if (result.stdout === expectedValue) {
    return { ok: true, matches: true };
  }
  return isUnreadableOutput(result.stdout, expectedValue)
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
