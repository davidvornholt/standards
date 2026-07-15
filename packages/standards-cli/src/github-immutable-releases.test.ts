import { afterEach, describe, expect, it } from 'bun:test';
import {
  applyImmutableReleasePolicy,
  diffImmutableReleases,
  fetchImmutableReleases,
} from './github-immutable-releases';

const originalFetch = globalThis.fetch;
const ENFORCED_BY_OWNER = 'enforced_by_owner';
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_NO_CONTENT = 204;

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('immutable releases live state', () => {
  it('decodes enabled state and reports drift', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        json({ enabled: false, [ENFORCED_BY_OWNER]: false }),
      )) as unknown as typeof fetch;
    const live = await fetchImmutableReleases('token', 'owner/repo', true);
    expect(live).toEqual({
      enabled: false,
      problem: null,
      unverifiable: false,
    });
    expect(diffImmutableReleases(true, live)).toEqual({
      drifted: ['immutable releases are false on GitHub, declared true'],
      unverifiable: [],
    });
  });

  it('treats documented 404 state as disabled', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        json({ message: 'Not Found' }, HTTP_NOT_FOUND),
      )) as unknown as typeof fetch;
    expect(await fetchImmutableReleases('token', 'owner/repo', true)).toEqual({
      enabled: false,
      problem: null,
      unverifiable: false,
    });
    expect(await fetchImmutableReleases('token', 'owner/repo', false)).toEqual({
      enabled: null,
      problem: null,
      unverifiable: true,
    });
  });

  it('keeps non-admin check failures unverifiable but fails apply reads', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        json({ message: 'Forbidden' }, HTTP_FORBIDDEN),
      )) as unknown as typeof fetch;
    const check = await fetchImmutableReleases('token', 'owner/repo', false);
    expect(check).toEqual({ enabled: null, problem: null, unverifiable: true });
    expect(diffImmutableReleases(true, check)).toEqual({
      drifted: [],
      unverifiable: ['immutable releases policy'],
    });
    expect(
      await fetchImmutableReleases('token', 'owner/repo', true),
    ).toMatchObject({
      enabled: null,
      problem: 'reading immutable releases policy: HTTP 403 Forbidden',
      unverifiable: false,
    });
  });

  it('rejects malformed successful responses', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(json({ enabled: true }))) as unknown as typeof fetch;
    expect(
      await fetchImmutableReleases('token', 'owner/repo', true),
    ).toMatchObject({
      enabled: null,
      problem:
        'reading immutable releases policy: HTTP 200 unexpected response',
    });
  });
});

describe('immutable releases apply', () => {
  it('enables documented 404-disabled state and verifies the readback', async () => {
    const calls: Array<string> = [];
    const responses = [
      json({ message: 'Not Found' }, HTTP_NOT_FOUND),
      new Response(null, { status: HTTP_NO_CONTENT }),
      json({ enabled: true, [ENFORCED_BY_OWNER]: false }),
    ];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
      return Promise.resolve(responses.shift() as Response);
    }) as unknown as typeof fetch;
    const live = await fetchImmutableReleases('token', 'owner/repo', true);
    const actions: Array<string> = [];
    await applyImmutableReleasePolicy({
      beforeMutation: () => Promise.resolve(),
      declared: true,
      live,
      reportAction: (action) => actions.push(action),
      repo: 'owner/repo',
      token: 'token',
    });
    expect(calls).toEqual([
      'GET /repos/owner/repo/immutable-releases',
      'PUT /repos/owner/repo/immutable-releases',
      'GET /repos/owner/repo/immutable-releases',
    ]);
    expect(actions).toEqual(['enabled immutable releases']);
  });

  it('runs the declaration guard before mutation', async () => {
    let requests = 0;
    globalThis.fetch = (() => {
      requests += 1;
      return Promise.reject(new Error('unexpected request'));
    }) as unknown as typeof fetch;
    await expect(
      applyImmutableReleasePolicy({
        beforeMutation: () => Promise.reject(new Error('changed')),
        declared: true,
        live: { enabled: false, problem: null, unverifiable: false },
        reportAction: () => undefined,
        repo: 'owner/repo',
        token: 'token',
      }),
    ).rejects.toThrow('changed');
    expect(requests).toBe(0);
  });
});
