import { describe, expect, it } from 'bun:test';
import { flip, runPromise } from './release-effect';
import {
  loadGithubState,
  loadTagSha,
  type ReleaseFetcher,
} from './release-github-api';

type GitIdentity = { readonly sha: string; readonly type: string };

const HTTP_NOT_FOUND = 404;
const HTTP_OK = 200;
const MAX_TAG_HOPS = 8;
const REF_LOOKUP_COUNT = 1;
const TAG_NAME_FIELD = 'tag_name';

const json = (body: unknown, status: number): Response =>
  Response.json(body, { status });

const github = (
  reference: GitIdentity,
  annotated: Readonly<Record<string, GitIdentity>> = {},
) => {
  const calls: Array<string> = [];
  const fetcher: ReleaseFetcher = (requestInput) => {
    const path = new URL(String(requestInput)).pathname;
    calls.push(path);
    if (path.endsWith('/git/ref/tags/v0.5.0')) {
      return Promise.resolve(json({ object: reference }, HTTP_OK));
    }
    const sha = path.split('/').at(-1) ?? '';
    const object = annotated[sha];
    return Promise.resolve(
      object === undefined
        ? json({ message: 'Not Found' }, HTTP_NOT_FOUND)
        : json({ object }, HTTP_OK),
    );
  };
  return {
    calls,
    client: {
      apiUrl: 'https://github.test',
      fetcher,
      repo: 'owner/repo',
      token: 'token',
    },
  };
};

describe('GitHub tag peeling', () => {
  it('resolves a lightweight tag directly to its commit', async () => {
    const remote = github({ sha: 'commit', type: 'commit' });
    expect(await runPromise(loadTagSha(remote.client, 'v0.5.0'))).toBe(
      'commit',
    );
    expect(remote.calls).toHaveLength(REF_LOOKUP_COUNT);
  });

  it('peels one or multiple annotated tag objects', async () => {
    const cases = [
      {
        annotated: { first: { sha: 'commit', type: 'commit' } },
        reference: { sha: 'first', type: 'tag' },
      },
      {
        annotated: {
          first: { sha: 'second', type: 'tag' },
          second: { sha: 'commit', type: 'commit' },
        },
        reference: { sha: 'first', type: 'tag' },
      },
    ] as const;
    const commits = await Promise.all(
      cases.map((testCase) => {
        const remote = github(testCase.reference, testCase.annotated);
        return runPromise(loadTagSha(remote.client, 'v0.5.0'));
      }),
    );
    for (const commit of commits) {
      expect(commit).toBe('commit');
    }
  });

  it('rejects an annotated tag with a terminal non-commit object', async () => {
    const remote = github(
      { sha: 'first', type: 'tag' },
      { first: { sha: 'tree', type: 'tree' } },
    );
    expect(
      await runPromise(flip(loadTagSha(remote.client, 'v0.5.0'))),
    ).toMatchObject({
      _tag: 'GithubApiError',
      message: 'GitHub tag resolves to tree, expected commit',
    });
  });

  it('rejects annotated tag nesting beyond the depth limit', async () => {
    const annotated = Object.fromEntries(
      Array.from({ length: MAX_TAG_HOPS }, (_, index) => [
        `tag-${index}`,
        { sha: `tag-${index + 1}`, type: 'tag' },
      ]),
    );
    const remote = github({ sha: 'tag-0', type: 'tag' }, annotated);
    expect(
      await runPromise(flip(loadTagSha(remote.client, 'v0.5.0'))),
    ).toMatchObject({
      _tag: 'GithubApiError',
      message: 'GitHub annotated tag chain is too deep',
    });
    expect(remote.calls).toHaveLength(MAX_TAG_HOPS + REF_LOOKUP_COUNT);
  });
});

describe('GitHub release state', () => {
  it('decodes absent, draft, prerelease, and published independently', async () => {
    const cases = [
      {
        body: { message: 'Not Found' },
        expected: 'absent',
        status: HTTP_NOT_FOUND,
      },
      {
        body: {
          draft: true,
          prerelease: false,
          [TAG_NAME_FIELD]: 'v0.5.0',
        },
        expected: 'draft',
        status: HTTP_OK,
      },
      {
        body: {
          draft: false,
          prerelease: true,
          [TAG_NAME_FIELD]: 'v0.5.0',
        },
        expected: 'prerelease',
        status: HTTP_OK,
      },
      {
        body: {
          draft: true,
          prerelease: true,
          [TAG_NAME_FIELD]: 'v0.5.0',
        },
        expected: 'prerelease',
        status: HTTP_OK,
      },
      {
        body: {
          draft: false,
          prerelease: false,
          [TAG_NAME_FIELD]: 'v0.5.0',
        },
        expected: 'published',
        status: HTTP_OK,
      },
    ] as const;
    const statuses = await Promise.all(
      cases.map(({ body, status }) => {
        const fetcher: ReleaseFetcher = (requestInput) =>
          Promise.resolve(
            new URL(String(requestInput)).pathname.includes('/releases/tags/')
              ? json(body, status)
              : json({ object: { sha: 'expected', type: 'commit' } }, HTTP_OK),
          );
        return runPromise(
          loadGithubState(
            {
              apiUrl: 'https://github.test',
              fetcher,
              repo: 'owner/repo',
              token: 'token',
            },
            'v0.5.0',
          ),
        ).then(({ releaseStatus }) => releaseStatus);
      }),
    );
    expect(statuses).toEqual(cases.map(({ expected }) => expected));
  });
});
