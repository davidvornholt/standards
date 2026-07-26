// Everything `creds add cloudflare` can settle before it mints anything: which
// resource the token will reach, and whether each destination is a writable
// scalar leaf. Minting first and discovering these afterwards would leave a
// live credential nobody asked for.

import type { PolicyResource } from './creds-add-policy';
import { parseZoneArgument } from './creds-cloudflare-zone';
import {
  DEFAULT_R2_JURISDICTION,
  isR2BucketName,
  type R2Jurisdiction,
} from './creds-r2';
import { inspectSopsScalarDestination } from './creds-sops';

export const inspectDestinations = async (
  consumer: string,
  rel: string,
  paths: ReadonlyArray<string>,
): Promise<string | null> => {
  const inspected = await Promise.all(
    paths.map((path) => inspectSopsScalarDestination(consumer, rel, path)),
  );
  const blocked = inspected.find((result) => !result.ok);
  return blocked !== undefined && !blocked.ok ? blocked.problem : null;
};

export type ResolvedResourceFlags =
  | { readonly ok: true; readonly resource: PolicyResource }
  | { readonly ok: false; readonly problem: string };

// A token reaches one kind of resource, so the flags naming it collapse to that
// one choice here — before any provider or SOPS work, because no rejection
// below can be salvaged afterwards.
export const resolveResourceFlags = (options: {
  readonly bucket: string | undefined;
  readonly zone: string | undefined;
  readonly jurisdiction?: R2Jurisdiction;
}): ResolvedResourceFlags => {
  if (options.bucket !== undefined && options.zone !== undefined) {
    return {
      ok: false,
      problem:
        '--bucket and --zone cannot be combined; an R2 bucket credential and a zone credential are separate tokens',
    };
  }
  if (options.bucket !== undefined) {
    return isR2BucketName(options.bucket)
      ? {
          ok: true,
          resource: {
            kind: 'bucket',
            bucket: options.bucket,
            jurisdiction: options.jurisdiction ?? DEFAULT_R2_JURISDICTION,
          },
        }
      : {
          ok: false,
          problem: `invalid R2 bucket name: ${options.bucket} (3-63 lowercase letters, digits, and hyphens)`,
        };
  }
  if (options.zone === undefined) {
    return { ok: true, resource: { kind: 'account' } };
  }
  const zones = parseZoneArgument(options.zone);
  return zones.ok
    ? { ok: true, resource: { kind: 'zones', zoneIds: zones.zoneIds } }
    : { ok: false, problem: zones.problem };
};
