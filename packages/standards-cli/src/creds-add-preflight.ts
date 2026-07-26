// Everything `creds add cloudflare` can settle before it mints anything: the
// flag combinations that cannot be salvaged later, and whether each destination
// is a writable scalar leaf. Minting first and discovering these afterwards
// would leave a live credential nobody asked for.

import {
  type ParsedZoneArgument,
  parseZoneArgument,
} from './creds-cloudflare-zone';
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

// Settled before any provider or SOPS work, because neither combination can be
// salvaged later: a bucket credential and a zone credential are separate tokens.
export const parseZoneFlags = (options: {
  readonly bucket: string | undefined;
  readonly zone: string | undefined;
}): ParsedZoneArgument => {
  if (options.bucket !== undefined && options.zone !== undefined) {
    return {
      ok: false,
      problem:
        '--bucket and --zone cannot be combined; an R2 bucket credential and a zone credential are separate tokens',
    };
  }
  return options.zone === undefined
    ? { ok: true, zoneIds: [] }
    : parseZoneArgument(options.zone);
};
