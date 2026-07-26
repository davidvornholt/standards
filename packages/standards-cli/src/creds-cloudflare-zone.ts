// Zone resources for `standards creds add cloudflare`. Zones are named by ID,
// never by domain name: resolving a name would need Zone Read on the bootstrap
// token, which holds Account API Tokens / Edit and nothing else, so the lookup
// would fail — or, worse, come back empty and read as a missing zone. A zone ID
// is not a secret and is shown on the zone's dashboard overview.

import { isCloudflareId } from './creds-cloudflare-id';

export const ZONE_SCOPE = 'com.cloudflare.api.account.zone';

export const zoneResource = (zoneId: string): string =>
  `${ZONE_SCOPE}.${zoneId}`;

export type ParsedZoneArgument =
  | {
      readonly ok: true;
      readonly zoneIds: readonly [string, ...ReadonlyArray<string>];
    }
  | { readonly ok: false; readonly problem: string };

export const parseZoneArgument = (value: string): ParsedZoneArgument => {
  const [first, ...rest] = value
    .split(',')
    .map((zone) => zone.trim())
    .filter((zone) => zone.length > 0);
  if (first === undefined) {
    return {
      ok: false,
      problem: '--zone requires at least one zone ID',
    };
  }
  const entries = [first, ...rest] as const;
  const invalid = entries.filter((zone) => !isCloudflareId(zone));
  return invalid.length === 0
    ? { ok: true, zoneIds: entries }
    : {
        ok: false,
        problem: `not a zone ID: ${invalid.join(', ')}; --zone takes the 32-character hexadecimal zone ID shown on the zone's dashboard overview, not its domain name`,
      };
};
