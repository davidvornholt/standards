import { describe, expect, it } from 'bun:test';
import { authorizeReleaseSha } from './release-authorization';
import { flip, runPromise } from './release-effect';
import type { ReleaseFetcher } from './release-github-request';

const HTTP_OK = 200;
const RELEASE_SHA = 'release-sha';
const DEFAULT_BRANCH = 'default_branch';
const MERGE_BASE_COMMIT = 'merge_base_commit';

const remote = (input: {
  readonly branch?: unknown;
  readonly mergeBaseSha?: string;
  readonly status?: string;
}) => {
  const calls: Array<string> = [];
  const fetcher: ReleaseFetcher = (requestInput) => {
    const path = new URL(String(requestInput)).pathname;
    calls.push(path);
    return Promise.resolve(
      Response.json(
        path === '/repos/owner/repo'
          ? { [DEFAULT_BRANCH]: input.branch ?? 'trunk' }
          : {
              [MERGE_BASE_COMMIT]: {
                sha: input.mergeBaseSha ?? RELEASE_SHA,
              },
              status: input.status ?? 'ahead',
            },
        { status: HTTP_OK },
      ),
    );
  };
  return { calls, fetcher };
};

const authorize = (fetcher: ReleaseFetcher) =>
  authorizeReleaseSha({
    apiUrl: 'https://github.test',
    expectedSha: RELEASE_SHA,
    fetcher,
    repo: 'owner/repo',
    token: 'token',
  });

describe('release SHA authorization', () => {
  it('uses the freshly read live default branch after a queued payload rename', async () => {
    const github = remote({ branch: 'trunk' });
    expect(await runPromise(authorize(github.fetcher))).toBe('trunk');
    expect(github.calls).toEqual([
      '/repos/owner/repo',
      '/repos/owner/repo/compare/release-sha...trunk',
    ]);
  });

  it('accepts a SHA equal to the live default-branch head', async () => {
    const github = remote({ status: 'identical' });
    expect(await runPromise(authorize(github.fetcher))).toBe('trunk');
  });

  it('rejects non-ancestral and malformed comparison state', async () => {
    const failures = await Promise.all([
      runPromise(flip(authorize(remote({ status: 'diverged' }).fetcher))),
      runPromise(flip(authorize(remote({ mergeBaseSha: 'other' }).fetcher))),
      runPromise(flip(authorize(remote({ branch: 7 }).fetcher))),
    ]);
    expect(failures[0]).toMatchObject({
      _tag: 'GithubStateError',
      message:
        'Release SHA release-sha is not an ancestor of live default branch trunk',
    });
    expect(failures[1]).toMatchObject({ _tag: 'GithubStateError' });
    expect(failures[2]).toMatchObject({ _tag: 'GithubApiError' });
  });
});
