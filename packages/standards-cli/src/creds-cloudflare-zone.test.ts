import { describe, expect, it } from 'bun:test';
import { parseZoneArgument, zoneResource } from './creds-cloudflare-zone';

const ZONE_ID_LENGTH = 32;
const ZONE_A = `1${'b'.repeat(ZONE_ID_LENGTH - 1)}`;
const ZONE_B = `2${'c'.repeat(ZONE_ID_LENGTH - 1)}`;

describe('zoneResource', () => {
  it('addresses one zone under the account zone scope', () => {
    expect(zoneResource(ZONE_A)).toBe(
      `com.cloudflare.api.account.zone.${ZONE_A}`,
    );
  });
});

describe('parseZoneArgument', () => {
  it('splits a comma-separated list and drops surrounding blanks', () => {
    expect(parseZoneArgument(` ${ZONE_A} , ,${ZONE_B} `)).toEqual({
      ok: true,
      zoneIds: [ZONE_A, ZONE_B],
    });
  });

  it('rejects an argument holding no zone', () => {
    expect(parseZoneArgument(' , ')).toEqual({
      ok: false,
      problem: '--zone requires at least one zone ID',
    });
  });

  // Naming zones by domain is the expected mistake, so the rejection says what
  // a zone ID is and where to find it rather than only that the value is wrong.
  it('names every value that is not a zone ID', () => {
    const parsed = parseZoneArgument(`example.test,${ZONE_A},other.test`);
    expect(parsed).toEqual({
      ok: false,
      problem:
        "not a zone ID: example.test, other.test; --zone takes the 32-character hexadecimal zone ID shown on the zone's dashboard overview, not its domain name",
    });
  });

  it.each([
    ['too short', ZONE_A.slice(1)],
    ['too long', `${ZONE_A}0`],
    ['upper-case hex', ZONE_A.toUpperCase()],
    ['non-hex characters', `${'z'.repeat(ZONE_ID_LENGTH)}`],
  ])('rejects a zone ID that is %s', (_label, value) => {
    expect(parseZoneArgument(value).ok).toBe(false);
  });
});
