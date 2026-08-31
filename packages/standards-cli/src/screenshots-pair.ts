// Resolves the configured screenshots credential from its SOPS target: the
// same `<target>:<dotted.key>` pair shape `creds add cloudflare --s3` mints
// and dev-env references. The decrypted values stay in process memory for
// the upload and are never printed.

import type { CredsDestination } from './creds-dest';
import { lookupS3Pair } from './creds-r2';
import { resolveTargetRelResult } from './creds-target';
import { decryptSopsJson } from './sops-exec';

export type ScreenshotsPairResult =
  | {
      readonly ok: true;
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
    }
  | { readonly ok: false; readonly problem: string };

export const resolveScreenshotsPair = (
  consumer: string,
  pair: CredsDestination,
  bucket: string,
): ScreenshotsPairResult => {
  const mintHint = `mint the pair with \`bun standards creds add cloudflare --s3 --dest ${pair.target}:${pair.key} --bucket ${bucket} --permissions "Workers R2 Storage Bucket Item Write"\``;
  const resolved = resolveTargetRelResult(consumer, pair.target);
  if (!resolved.ok) {
    return {
      ok: false,
      problem:
        resolved.kind === 'missing'
          ? `${resolved.problem}; ${mintHint}`
          : resolved.problem,
    };
  }
  const document = decryptSopsJson(consumer, resolved.rel);
  if (!document.ok) {
    return { ok: false, problem: document.problem };
  }
  const lookup = lookupS3Pair(document.value, pair.key);
  if (!lookup.ok) {
    return {
      ok: false,
      problem:
        lookup.kind === 'missing-key'
          ? `${resolved.rel} has no key "${pair.key}"; ${mintHint}`
          : `${resolved.rel} key "${pair.key}" does not hold a complete S3 pair; both "access_key_id" and "secret_access_key" must be strings`,
    };
  }
  return {
    ok: true,
    accessKeyId: lookup.accessKeyId,
    secretAccessKey: lookup.secretAccessKey,
  };
};
