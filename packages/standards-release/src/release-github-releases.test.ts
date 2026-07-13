import { describe, expect, it } from 'bun:test';
import { flip, runPromise } from './release-effect';
import { loadGithubState, type ReleaseFetcher } from './release-github-api';

const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_OK = 200;
const RELEASES_PER_PAGE = 100;
const TAG_NAME_FIELD = 'tag_name';

const json = (body: unknown, status: number): Response =>
  Response.json(body, { status });

const release = (
  tag: string,
  flags: { readonly draft: boolean; readonly prerelease: boolean },
) => ({ ...flags, [TAG_NAME_FIELD]: tag });

const client = (fetcher: ReleaseFetcher) => ({
  apiUrl: 'https://github.test',
  fetcher,
  repo: 'owner/repo',
  token: 'token',
});

const tagResponse = (requestInput: RequestInfo | URL): Response | null =>
  new URL(String(requestInput)).pathname.includes('/git/ref/tags/')
    ? json({ object: { sha: 'expected', type: 'commit' } }, HTTP_OK)
    : null;

describe('GitHub release listing', () => {
  it('finds an exact draft that the by-tag endpoint would hide', async () => {
    const calls: Array<string> = [];
    const fetcher: ReleaseFetcher = (requestInput) => {
      const url = new URL(String(requestInput));
      calls.push(`${url.pathname}${url.search}`);
      const tag = tagResponse(requestInput);
      if (tag !== null) {
        return Promise.resolve(tag);
      }
      return Promise.resolve(
        url.pathname.includes('/releases/tags/')
          ? json({ message: 'Not Found' }, HTTP_NOT_FOUND)
          : json(
              [release('v0.5.0', { draft: true, prerelease: false })],
              HTTP_OK,
            ),
      );
    };
    expect(
      await runPromise(loadGithubState(client(fetcher), 'v0.5.0')),
    ).toEqual({ releaseStatus: 'draft', tagSha: 'expected' });
    expect(calls).toContain('/repos/owner/repo/releases?per_page=100&page=1');
    expect(calls.some((path) => path.includes('/releases/tags/'))).toBe(false);
  });

  it('selects the exact tag from a later page', async () => {
    const calls: Array<string> = [];
    const firstPage = Array.from({ length: RELEASES_PER_PAGE }, (_, index) =>
      release(`v0.4.${index}`, { draft: false, prerelease: false }),
    );
    const fetcher: ReleaseFetcher = (requestInput) => {
      const url = new URL(String(requestInput));
      calls.push(`${url.pathname}${url.search}`);
      const tag = tagResponse(requestInput);
      if (tag !== null) {
        return Promise.resolve(tag);
      }
      return Promise.resolve(
        json(
          url.searchParams.get('page') === '1'
            ? firstPage
            : [release('v0.5.0', { draft: false, prerelease: true })],
          HTTP_OK,
        ),
      );
    };
    expect(
      await runPromise(loadGithubState(client(fetcher), 'v0.5.0')),
    ).toEqual({ releaseStatus: 'prerelease', tagSha: 'expected' });
    expect(calls.slice(0, 2)).toEqual([
      '/repos/owner/repo/releases?per_page=100&page=1',
      '/repos/owner/repo/releases?per_page=100&page=2',
    ]);
  });
});

describe('GitHub release classification and failures', () => {
  it('preserves absent, draft, prerelease, and published classification', async () => {
    const cases = [
      { expected: 'absent', releases: [] },
      {
        expected: 'draft',
        releases: [release('v0.5.0', { draft: true, prerelease: false })],
      },
      {
        expected: 'prerelease',
        releases: [release('v0.5.0', { draft: true, prerelease: true })],
      },
      {
        expected: 'published',
        releases: [release('v0.5.0', { draft: false, prerelease: false })],
      },
    ] as const;
    const statuses = await Promise.all(
      cases.map(({ releases }) => {
        const fetcher: ReleaseFetcher = (requestInput) =>
          Promise.resolve(tagResponse(requestInput) ?? json(releases, HTTP_OK));
        return runPromise(loadGithubState(client(fetcher), 'v0.5.0')).then(
          ({ releaseStatus }) => releaseStatus,
        );
      }),
    );
    expect(statuses).toEqual(cases.map(({ expected }) => expected));
  });

  it('fails closed on later-page auth and malformed release state', async () => {
    const fullPage = Array.from({ length: RELEASES_PER_PAGE }, (_, index) =>
      release(`v0.4.${index}`, { draft: false, prerelease: false }),
    );
    const failures = await Promise.all([
      runPromise(
        flip(
          loadGithubState(
            client((requestInput) => {
              const url = new URL(String(requestInput));
              const tag = tagResponse(requestInput);
              if (tag !== null) {
                return Promise.resolve(tag);
              }
              return Promise.resolve(
                url.searchParams.get('page') === '1'
                  ? json(fullPage, HTTP_OK)
                  : json({ message: 'Forbidden' }, HTTP_FORBIDDEN),
              );
            }),
            'v0.5.0',
          ),
        ),
      ),
      runPromise(
        flip(
          loadGithubState(
            client(() => Promise.resolve(json([{ draft: true }], HTTP_OK))),
            'v0.5.0',
          ),
        ),
      ),
    ]);
    expect(failures[0]).toMatchObject({
      _tag: 'GithubApiError',
      message: 'Listing GitHub releases page 2: HTTP 403 Forbidden',
    });
    expect(failures[1]).toMatchObject({
      _tag: 'GithubApiError',
      message: 'GitHub release list page 1 returned invalid release state',
    });
  });
});
