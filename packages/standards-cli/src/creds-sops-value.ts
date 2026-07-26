// Proving that a stored secret matches the value that was just minted, without
// that value reaching a return type, a log line, or an error message. Callers
// treat a proven mismatch as reason to destroy the new credential, so the two
// negative answers — mismatch and unverifiable — must stay distinct.

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

// Extracting a scalar leaf prints the value itself, not a JSON document, so a
// raw comparison is the normal path and JSON parsing only covers a sops that
// quotes it. The optional trailing newline is sops's own framing.
const matchesRawScalar = (stdout: string, expectedValue: string): boolean =>
  stdout === expectedValue || stdout === `${expectedValue}\n`;

const matchesQuotedScalar = (
  stdout: string,
  expectedValue: string,
): boolean => {
  try {
    const stored: unknown = JSON.parse(stdout);
    return stored === expectedValue;
  } catch {
    // A raw scalar that is not valid JSON, such as a hex access key ID that
    // reads as a malformed number. The raw comparison already decided it.
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
  // A read that answered nothing is unverifiable rather than a mismatch: the
  // mismatch branch destroys a credential, so an empty read must not reach it.
  if (result.status !== 0 || result.stdout === '') {
    return { ok: false, problem };
  }
  return {
    ok: true,
    matches:
      matchesRawScalar(result.stdout, expectedValue) ||
      matchesQuotedScalar(result.stdout, expectedValue),
  };
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
