// Zone resources for `standards creds add cloudflare`. A zone ID is used as
// given, so the common path needs no extra reach: resolving a zone *name* costs
// a lookup the bootstrap token may not be permitted to make, and the failure
// says so rather than reporting the zone as missing.

import { type CfResult, cfRequest } from './creds-cloudflare-api';
import { isRecord } from './github-settings-parse';

export const ZONE_SCOPE = 'com.cloudflare.api.account.zone';

const ZONE_ID_PATTERN = /^[0-9a-f]{32}$/u;

export const zoneResource = (zoneId: string): string =>
  `${ZONE_SCOPE}.${zoneId}`;

export const parseZoneArgument = (value: string): ReadonlyArray<string> =>
  value
    .split(',')
    .map((zone) => zone.trim())
    .filter((zone) => zone.length > 0);

const matchingZoneId = (result: unknown, zone: string): string | null => {
  if (!Array.isArray(result)) {
    return null;
  }
  for (const entry of result) {
    if (
      isRecord(entry) &&
      entry.name === zone &&
      typeof entry.id === 'string' &&
      entry.id.length > 0
    ) {
      return entry.id;
    }
  }
  return null;
};

export const resolveZoneId = async (
  token: string,
  zone: string,
): Promise<CfResult<string>> => {
  if (ZONE_ID_PATTERN.test(zone)) {
    return { ok: true, value: zone };
  }
  const response = await cfRequest(
    token,
    'GET',
    `/zones?name=${encodeURIComponent(zone)}`,
  );
  const byIdInstead =
    'pass its 32-character zone ID instead, which is used as given and needs no lookup';
  if (!response.ok) {
    return {
      ok: false,
      problem: `could not look up zone ${zone}: ${response.problem}; the lookup needs Zone Read on the broker token, so ${byIdInstead}`,
    };
  }
  const zoneId = matchingZoneId(response.value.result, zone);
  return zoneId === null
    ? {
        ok: false,
        problem: `no zone named ${zone} is visible to the broker token; ${byIdInstead}`,
      }
    : { ok: true, value: zoneId };
};
