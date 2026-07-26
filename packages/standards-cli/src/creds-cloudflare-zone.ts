// Zone resources for `standards creds add cloudflare`. Zones are named by ID,
// never by domain name: resolving a name would need Zone Read on the bootstrap
// token, which holds Account API Tokens / Edit and nothing else, so the lookup
// would fail — or, worse, come back empty and read as a missing zone. A zone ID
// is not a secret and is shown on the zone's dashboard overview.

export const ZONE_SCOPE = 'com.cloudflare.api.account.zone';

const ZONE_ID_PATTERN = /^[0-9a-f]{32}$/u;

export const zoneResource = (zoneId: string): string =>
  `${ZONE_SCOPE}.${zoneId}`;

export type ParsedZoneArgument =
  | { readonly ok: true; readonly zoneIds: ReadonlyArray<string> }
  | { readonly ok: false; readonly problem: string };

export const parseZoneArgument = (value: string): ParsedZoneArgument => {
  const entries = value
    .split(',')
    .map((zone) => zone.trim())
    .filter((zone) => zone.length > 0);
  if (entries.length === 0) {
    return {
      ok: false,
      problem: '--zone requires at least one zone ID',
    };
  }
  const invalid = entries.filter((zone) => !ZONE_ID_PATTERN.test(zone));
  return invalid.length === 0
    ? { ok: true, zoneIds: entries }
    : {
        ok: false,
        problem: `not a zone ID: ${invalid.join(', ')}; --zone takes the 32-character hexadecimal zone ID shown on the zone's dashboard overview, not its domain name`,
      };
};
