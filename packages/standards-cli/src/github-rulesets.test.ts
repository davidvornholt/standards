import { afterEach, describe, expect, it } from 'bun:test';
import { fetchLiveRulesets } from './github-rulesets';

const originalFetch = globalThis.fetch;
const FIRST_PAGE_SIZE = 100;
const TOTAL_RULESETS = 101;
const BYPASS_ACTORS = 'bypass_actors';
const REF_NAME = 'ref_name';
const response = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200 });
const identity = (id: number): unknown =>
  JSON.parse(
    `{"id":${id},"name":"Rules ${id}","source":"owner/repo","source_type":"Repository"}`,
  ) as unknown;
const detail = (
  id: number,
  overrides: Readonly<Record<string, unknown>> = {},
): unknown => ({
  ...(identity(id) as Record<string, unknown>),
  [BYPASS_ACTORS]: [],
  conditions: { [REF_NAME]: { exclude: [], include: ['~DEFAULT_BRANCH'] } },
  enforcement: 'active',
  rules: [{ type: 'deletion' }],
  target: 'branch',
  ...overrides,
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('repository ruleset reads', () => {
  it('paginates repository-only summaries before reading every detail', async () => {
    const urls: Array<string> = [];
    globalThis.fetch = Object.assign(
      (input: URL | RequestInfo) => {
        const url = String(input);
        urls.push(url);
        if (url.includes('&page=1')) {
          return Promise.resolve(
            response(
              Array.from({ length: FIRST_PAGE_SIZE }, (_, index) =>
                identity(index + 1),
              ),
            ),
          );
        }
        if (url.includes('&page=2')) {
          return Promise.resolve(response([identity(TOTAL_RULESETS)]));
        }
        return Promise.resolve(response(detail(Number(url.split('/').at(-1)))));
      },
      { preconnect: originalFetch.preconnect },
    );
    const live = await fetchLiveRulesets('token', 'owner/repo', false);
    expect(live.rulesets).toHaveLength(TOTAL_RULESETS);
    expect(urls.some((url) => url.includes('includes_parents=false'))).toBe(
      true,
    );
    expect(urls.some((url) => url.includes('&page=2'))).toBe(true);
  });

  it('fails closed on duplicate or foreign summary identities', async () => {
    globalThis.fetch = Object.assign(
      () => Promise.resolve(response([identity(1), identity(1)])),
      { preconnect: originalFetch.preconnect },
    );
    expect(
      (await fetchLiveRulesets('token', 'owner/repo', false)).rulesets,
    ).toBeNull();
    const foreign = JSON.parse(
      '{"id":1,"name":"Rules 1","source":"other/repo","source_type":"Repository"}',
    ) as unknown;
    globalThis.fetch = Object.assign(
      () => Promise.resolve(response([foreign])),
      { preconnect: originalFetch.preconnect },
    );
    expect(
      (await fetchLiveRulesets('token', 'owner/repo', false)).rulesets,
    ).toBeNull();
  });

  it('fails closed when a detail identity mismatches its requested summary', async () => {
    globalThis.fetch = Object.assign(
      (input: URL | RequestInfo) =>
        Promise.resolve(
          response(
            String(input).includes('rulesets?')
              ? [identity(1)]
              : detail(1, { name: 'Other' }),
          ),
        ),
      { preconnect: originalFetch.preconnect },
    );
    expect(await fetchLiveRulesets('token', 'owner/repo', false)).toEqual({
      problem:
        'listing rulesets: GitHub returned a detailed repository ruleset identity mismatched its summary',
      rulesets: null,
    });
  });

  it('fails closed when detailed identities collapse to a duplicate', async () => {
    globalThis.fetch = Object.assign(
      (input: URL | RequestInfo) =>
        Promise.resolve(
          response(
            String(input).includes('rulesets?')
              ? [identity(1), identity(2)]
              : detail(1),
          ),
        ),
      { preconnect: originalFetch.preconnect },
    );
    expect(await fetchLiveRulesets('token', 'owner/repo', false)).toEqual({
      problem:
        'listing rulesets: GitHub returned duplicate detailed repository ruleset identities',
      rulesets: null,
    });
  });
});
