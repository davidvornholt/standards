import { afterEach, describe, expect, it } from 'bun:test';
import { parseZoneArgument, resolveZoneId } from './creds-cloudflare-zone';

const ZONE_ID_LENGTH = 32;
const ZONE_ID = `1${'b'.repeat(ZONE_ID_LENGTH - 1)}`;
const originalFetch = globalThis.fetch;
const requested: Array<string> = [];
const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;

const stubZones = (payload: unknown, ok = true): void => {
  globalThis.fetch = ((input: string | URL | Request) => {
    requested.push(String(input));
    return Promise.resolve(
      Response.json(
        {
          success: ok,
          errors: ok ? [] : [{ message: 'Authentication error' }],
          result: payload,
        },
        { status: ok ? HTTP_OK : HTTP_FORBIDDEN },
      ),
    );
  }) as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  requested.length = 0;
});

describe('parseZoneArgument', () => {
  it('splits a comma-separated list and drops blanks', () => {
    expect(parseZoneArgument(' a.example , ,b.example ')).toEqual([
      'a.example',
      'b.example',
    ]);
  });

  it('yields nothing for an argument holding no zone', () => {
    expect(parseZoneArgument(' , ')).toEqual([]);
  });
});

describe('resolveZoneId', () => {
  it('uses a zone ID as given without spending a lookup', async () => {
    stubZones([]);
    expect(await resolveZoneId('bootstrap', ZONE_ID)).toEqual({
      ok: true,
      value: ZONE_ID,
    });
    expect(requested).toEqual([]);
  });

  it('resolves a zone name to its ID', async () => {
    stubZones([{ id: ZONE_ID, name: 'example.test' }]);
    expect(await resolveZoneId('bootstrap', 'example.test')).toEqual({
      ok: true,
      value: ZONE_ID,
    });
    expect(requested).toEqual([
      'https://api.cloudflare.com/client/v4/zones?name=example.test',
    ]);
  });

  // A name filter is server-side, but a stale or over-broad response must not be
  // taken as a match for a zone the operator did not name.
  it('rejects a response holding no exactly matching name', async () => {
    stubZones([{ id: ZONE_ID, name: 'other.test' }]);
    const result = await resolveZoneId('bootstrap', 'example.test');
    expect(result).toEqual({
      ok: false,
      problem:
        'no zone named example.test is visible to the broker token; pass its 32-character zone ID instead, which is used as given and needs no lookup',
    });
  });

  it('blames the missing lookup permission rather than the zone', async () => {
    stubZones(null, false);
    const result = await resolveZoneId('bootstrap', 'example.test');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.problem).toContain(
      'the lookup needs Zone Read on the broker token',
    );
  });
});
