// The live ruleset loader must see every ruleset the repository has. GitHub
// serves 30 per page by default and the endpoint really paginates, so a
// single-page read would hide an undeclared permissive ruleset that lands on a
// later page: the "exists on GitHub but is not declared" branch would never
// fire for it and the gate would pass on a repository nobody declared.

import { afterEach, describe, expect, it } from 'bun:test';
import { apiError, HTTP_FORBIDDEN } from './github-api';
import { installApi } from './github-commands-test-support';
import { fetchLiveRulesets } from './github-ruleset-api';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// github-paginate asks for this many per page and treats a full page as a
// reason to ask for the next one.
const PAGE_SIZE = 100;
const RULESET_ID = 7;

const parsed = (json: string): unknown => JSON.parse(json) as unknown;

const summary = (id: number, sourceType: string): unknown =>
  parsed(`{"id":${String(id)},"source_type":"${sourceType}"}`);

const detail = (id: number, name: string): unknown =>
  parsed(
    `{"id":${String(id)},"name":"${name}","target":"branch","enforcement":"active","rules":[]}`,
  );

const requests = (calls: ReadonlyArray<{ path: string; search: string }>) =>
  calls.map(({ path, search }) => `${path}${search}`);

describe('fetchLiveRulesets', () => {
  // The failure T4 describes: an org page fills page one and the repository's
  // own undeclared ruleset only appears on page two.
  it('follows every page before deciding what the repository has', async () => {
    const firstPage = Array.from({ length: PAGE_SIZE }, (_unused, index) =>
      summary(index + 1, 'Organization'),
    );
    const calls = installApi([
      { body: firstPage },
      { body: [summary(RULESET_ID, 'Repository')] },
      { body: detail(RULESET_ID, 'Handmade rules') },
    ]);

    const live = await fetchLiveRulesets('token', 'owner/repo');

    expect(live.problem).toBeNull();
    expect(live.rulesets).toEqual([
      detail(RULESET_ID, 'Handmade rules') as Record<string, unknown>,
    ]);
    expect(requests(calls)).toEqual([
      '/repos/owner/repo/rulesets?per_page=100&page=1',
      '/repos/owner/repo/rulesets?per_page=100&page=2',
      `/repos/owner/repo/rulesets/${String(RULESET_ID)}`,
    ]);
  });

  // Org-inherited rulesets are outside this declaration's authority, so they
  // are dropped before the detail reads rather than compared.
  it('reads details only for repository-owned rulesets', async () => {
    const calls = installApi([
      {
        body: [
          summary(RULESET_ID, 'Repository'),
          summary(RULESET_ID + 1, 'Organization'),
        ],
      },
      { body: detail(RULESET_ID, 'Protect main') },
    ]);

    const live = await fetchLiveRulesets('token', 'owner/repo');

    expect(live.rulesets).toEqual([
      detail(RULESET_ID, 'Protect main') as Record<string, unknown>,
    ]);
    expect(requests(calls)).toHaveLength(2);
  });
});

describe('fetchLiveRulesets fails closed', () => {
  // listAllPages throws, but the drift collector tells a ruleset read failure
  // apart from a label read failure by the returned problem string. The
  // conversion must therefore reproduce apiError exactly, byte for byte.
  it('converts a list failure into the same message apiError would print', async () => {
    const body = parsed('{"message":"Resource not accessible by integration"}');
    installApi([{ status: HTTP_FORBIDDEN, body }]);

    const live = await fetchLiveRulesets('token', 'owner/repo');

    expect(live.rulesets).toBeNull();
    expect(live.problem).toBe(
      apiError('listing rulesets', { status: HTTP_FORBIDDEN, body }),
    );
  });

  it('reports a page that is not a list rather than treating it as empty', async () => {
    installApi([{ body: parsed('{"message":"Not Found"}') }]);

    const live = await fetchLiveRulesets('token', 'owner/repo');

    expect(live.rulesets).toBeNull();
    expect(live.problem).toBe('listing rulesets: HTTP 200 Not Found');
  });

  it('reports a ruleset whose detail read failed', async () => {
    installApi([
      { body: [summary(RULESET_ID, 'Repository')] },
      { status: HTTP_FORBIDDEN, body: parsed('{"message":"Denied"}') },
    ]);

    const live = await fetchLiveRulesets('token', 'owner/repo');

    expect(live.rulesets).toBeNull();
    expect(live.problem).toBe('reading a ruleset: HTTP 403 Denied');
  });
});
