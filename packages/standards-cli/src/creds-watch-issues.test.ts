import { afterEach, describe, expect, it } from 'bun:test';
import type { DueToken } from './creds-watch-due';
import {
  renderIssue,
  syncExpiryIssues,
  WATCH_LABEL,
} from './creds-watch-issues';

const HOME = 'davidvornholt/personal-infra';
const originalFetch = globalThis.fetch;

type Call = { readonly method: string; readonly path: string; body: unknown };

const due = (repo: string, expiresOn: string, expired = false): DueToken => ({
  accountId: 'a'.repeat(32),
  tokenId: `id-${repo}`,
  name: `standards/${repo}/ci/ci.token`,
  repo,
  expiresOn,
  expired,
});

// A GitHub fake: answers the label, list, issue and comment endpoints and
// records every call.
const fakeGithub = (
  open: ReadonlyArray<unknown>,
  status: { readonly list?: number; readonly patch?: number } = {},
): Array<Call> => {
  const calls: Array<Call> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body =
      typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname + url.search, body });
    const reply = (code: number, payload: unknown): Promise<Response> =>
      Promise.resolve(Response.json(payload, { status: code }));
    if (url.pathname.endsWith('/labels')) {
      return reply(422, { message: 'Validation Failed' });
    }
    if (method === 'GET') {
      return reply(status.list ?? 200, open);
    }
    if (url.pathname.endsWith('/comments')) {
      return reply(201, { id: 1 });
    }
    if (method === 'POST') {
      return reply(201, { number: 7 });
    }
    return reply(status.patch ?? 200, {});
  }) as typeof fetch;
  return calls;
};

const issue = (number: number, repo: string, title = 'old', body?: string) => ({
  number,
  title,
  body: body ?? `<!-- standards-creds-watch: ${repo} -->\n\nold`,
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('creds watch issue text', () => {
  it('names the tokens, the earliest expiry, and the exact renewal command', () => {
    const rendered = renderIssue('owner/app', [
      due('owner/app', '2026-12-01T00:00:00.000Z'),
      due('owner/app', '2026-12-09T00:00:00.000Z'),
    ]);
    expect(rendered.title).toBe(
      'Brokered Cloudflare tokens of owner/app expire on 2026-12-01',
    );
    const lines = rendered.body.split('\n');
    expect(lines[0]).toBe('<!-- standards-creds-watch: owner/app -->');
    expect(lines[2]).toStartWith(
      '**Problem.** 2 brokered Cloudflare tokens of owner/app have expired or expire within 30 days',
    );
    expect(lines[4]).toStartWith('**Outcome.** ');
    expect(lines[6]).toBe('## Evidence');
    expect(rendered.body).toContain(
      '```sh\nbunx @davidvornholt/standards@latest creds apply\n```',
    );
    expect(
      renderIssue('owner/app', [due('owner/app', '2026-11-01T00:00:00Z', true)])
        .title,
    ).toBe('Brokered Cloudflare tokens of owner/app expired on 2026-11-01');
  });
});

describe('creds watch issue sync', () => {
  it('opens, updates, keeps, and closes issues by repository marker', async () => {
    const current = renderIssue('owner/same', [
      due('owner/same', '2026-12-01T00:00:00Z'),
    ]);
    const calls = fakeGithub([
      issue(1, 'owner/changed'),
      { number: 2, ...current },
      issue(3, 'owner/renewed'),
      { number: 4, title: 'unrelated', body: 'no marker' },
      // biome-ignore lint/style/useNamingConvention: GitHub's REST field.
      { ...issue(5, 'owner/pr'), pull_request: {} },
    ]);
    const result = await syncExpiryIssues({
      token: 't',
      home: HOME,
      byRepo: new Map([
        ['owner/changed', [due('owner/changed', '2026-12-02T00:00:00Z')]],
        ['owner/same', [due('owner/same', '2026-12-01T00:00:00Z')]],
        ['owner/new', [due('owner/new', '2026-12-03T00:00:00Z')]],
      ]),
      complete: true,
    });
    expect(result.problems).toEqual([]);
    const writes = calls
      .filter(({ method }) => method !== 'GET')
      .map(({ method, path }) => `${method} ${path}`);
    expect(writes).toEqual([
      `POST /repos/${HOME}/labels`,
      `PATCH /repos/${HOME}/issues/1`,
      `POST /repos/${HOME}/issues`,
      `POST /repos/${HOME}/issues/3/comments`,
      `PATCH /repos/${HOME}/issues/3`,
    ]);
    expect(calls.find(({ path }) => path.includes('labels='))?.path).toBe(
      `/repos/${HOME}/issues?state=open&labels=${WATCH_LABEL}&per_page=100`,
    );
    expect(
      calls.find(
        ({ method, path }) => method === 'POST' && path.endsWith('/issues'),
      )?.body,
    ).toEqual(expect.objectContaining({ labels: [WATCH_LABEL] }));
    expect(calls.at(-1)?.body).toEqual({
      state: 'closed',
      // biome-ignore lint/style/useNamingConvention: GitHub's REST field.
      state_reason: 'completed',
    });
    expect(result.lines).toContain(`${HOME}#2 is current`);
  });

  it('closes nothing when some account could not be listed', async () => {
    const calls = fakeGithub([issue(3, 'owner/unseen')]);
    const result = await syncExpiryIssues({
      token: 't',
      home: HOME,
      byRepo: new Map(),
      complete: false,
    });
    expect(result.problems).toEqual([]);
    expect(calls.map(({ method }) => method)).toEqual(['POST', 'GET']);
  });

  it('fails without writing issues when the open list is full or unreadable', async () => {
    const full = Array.from({ length: 100 }, (_, index) =>
      issue(index + 1, `owner/r${index}`),
    );
    fakeGithub(full);
    const crowded = await syncExpiryIssues({
      token: 't',
      home: HOME,
      byRepo: new Map(),
      complete: true,
    });
    expect(crowded.problems).toEqual([
      expect.stringContaining('100 or more open'),
    ]);
    const calls = fakeGithub([], { list: 500 });
    const broken = await syncExpiryIssues({
      token: 't',
      home: HOME,
      byRepo: new Map([['owner/a', [due('owner/a', '2026-12-01T00:00:00Z')]]]),
      complete: true,
    });
    expect(broken.problems).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it('reports a failed close without claiming it', async () => {
    fakeGithub([issue(3, 'owner/renewed')], { patch: 403 });
    const result = await syncExpiryIssues({
      token: 't',
      home: HOME,
      byRepo: new Map(),
      complete: true,
    });
    expect(result.problems).toHaveLength(1);
    expect(result.lines).toEqual([]);
  });
});
