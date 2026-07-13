import { describe, expect, it } from 'bun:test';
import { flip, runPromise } from './release-effect';
import {
  inspectGithubRelease,
  type ReleaseFetcher,
  reconcileGithubRelease,
} from './release-github';

type RemoteState = {
  release: 'absent' | 'draft' | 'prerelease' | 'published';
  tagSha: string | null;
};

const HTTP_CREATED = 201;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_OK = 200;
const HTTP_UNPROCESSABLE = 422;
const HTTP_UNEXPECTED = 500;
const RELEASE_NOTES_FIELD = 'generate_release_notes';
const TAG_NAME_FIELD = 'tag_name';
const TARGET_COMMIT_FIELD = 'target_commitish';

const json = (body: unknown, status: number): Response =>
  Response.json(body, { status });

const remote = (
  state: RemoteState,
  options: {
    readonly releaseRace?: boolean;
    readonly tagRaceSha?: string | null;
  } = {},
) => {
  const calls: Array<string> = [];
  const bodies: Array<unknown> = [];
  const readResponse = (path: string): Response => {
    if (path.endsWith('/releases')) {
      return state.release === 'absent'
        ? json([], HTTP_OK)
        : json(
            [
              {
                draft: state.release === 'draft',
                prerelease: state.release === 'prerelease',
                [TAG_NAME_FIELD]: 'v0.5.0',
              },
            ],
            HTTP_OK,
          );
    }
    return state.tagSha === null
      ? json({ message: 'Not Found' }, HTTP_NOT_FOUND)
      : json({ object: { sha: state.tagSha, type: 'commit' } }, HTTP_OK);
  };
  const createTag = (): Response => {
    if (options.tagRaceSha !== undefined) {
      state.tagSha = options.tagRaceSha;
      return json({ message: 'Reference was not created' }, HTTP_UNPROCESSABLE);
    }
    state.tagSha = 'expected';
    return json({ ref: 'refs/tags/v0.5.0' }, HTTP_CREATED);
  };
  const createRelease = (): Response => {
    state.release = 'published';
    return options.releaseRace === true
      ? json({ message: 'already_exists' }, HTTP_UNPROCESSABLE)
      : json({ [TAG_NAME_FIELD]: 'v0.5.0' }, HTTP_CREATED);
  };
  const writeResponse = (path: string): Response => {
    if (path.endsWith('/git/refs')) {
      return createTag();
    }
    return path.endsWith('/releases')
      ? createRelease()
      : json({ message: 'unexpected route' }, HTTP_UNEXPECTED);
  };
  const fetcher: ReleaseFetcher = (requestInput, init) => {
    const url = new URL(String(requestInput));
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}`);
    if (init?.body !== undefined) {
      bodies.push(JSON.parse(String(init.body)) as unknown);
    }
    const response =
      method === 'GET'
        ? readResponse(url.pathname)
        : writeResponse(url.pathname);
    return Promise.resolve(response);
  };
  return { bodies, calls, fetcher };
};

const input = (fetcher: ReleaseFetcher) => ({
  apiUrl: 'https://github.test',
  expectedSha: 'expected',
  fetcher,
  repo: 'owner/repo',
  tag: 'v0.5.0',
  token: 'token',
});

describe('GitHub release boundary', () => {
  it('preflights absent and exact existing remote states', async () => {
    const absent = remote({ release: 'absent', tagSha: null });
    expect(await runPromise(inspectGithubRelease(input(absent.fetcher)))).toBe(
      'create',
    );
    const existing = remote({ release: 'published', tagSha: 'expected' });
    expect(
      await runPromise(inspectGithubRelease(input(existing.fetcher))),
    ).toBe('exists');
  });

  it('verifies the tag before release creation and pins target commit', async () => {
    const state = remote({ release: 'absent', tagSha: null });
    expect(await runPromise(reconcileGithubRelease(input(state.fetcher)))).toBe(
      'exists',
    );
    const createTag = state.calls.indexOf('POST /repos/owner/repo/git/refs');
    const createRelease = state.calls.indexOf(
      'POST /repos/owner/repo/releases',
    );
    expect(createRelease).toBeGreaterThan(createTag);
    expect(state.calls.slice(createTag + 1, createRelease)).toContain(
      'GET /repos/owner/repo/git/ref/tags/v0.5.0',
    );
    expect(state.bodies).toContainEqual({
      [RELEASE_NOTES_FIELD]: true,
      name: 'v0.5.0',
      [TAG_NAME_FIELD]: 'v0.5.0',
      [TARGET_COMMIT_FIELD]: 'expected',
    });
  });

  it('accepts exact tag and release creation races idempotently', async () => {
    const tagRace = remote(
      { release: 'absent', tagSha: null },
      { tagRaceSha: 'expected' },
    );
    expect(
      await runPromise(reconcileGithubRelease(input(tagRace.fetcher))),
    ).toBe('exists');
    const releaseRace = remote(
      { release: 'absent', tagSha: 'expected' },
      { releaseRace: true },
    );
    expect(
      await runPromise(reconcileGithubRelease(input(releaseRace.fetcher))),
    ).toBe('exists');
  });

  it('rejects unresolved or conflicting tag creation 422 responses', async () => {
    const results = await Promise.all(
      [null, 'other'].map((tagRaceSha) => {
        const state = remote(
          { release: 'absent', tagSha: null },
          { tagRaceSha },
        );
        return runPromise(
          flip(reconcileGithubRelease(input(state.fetcher))),
        ).then((failure) => ({ failure, state }));
      }),
    );
    for (const { failure, state } of results) {
      expect(failure).toMatchObject({ _tag: 'GithubStateError' });
      expect(state.calls).not.toContain('POST /repos/owner/repo/releases');
    }
  });

  it('rejects drafts, prereleases, missing published tags, and remote errors', async () => {
    const stateFailures = await Promise.all(
      [
        { release: 'draft' as const, tagSha: 'expected' },
        { release: 'prerelease' as const, tagSha: 'expected' },
        { release: 'published' as const, tagSha: null },
      ].map((state) => {
        const github = remote(state);
        return runPromise(flip(inspectGithubRelease(input(github.fetcher))));
      }),
    );
    for (const failure of stateFailures) {
      expect(failure).toMatchObject({ _tag: 'GithubStateError' });
    }
    const apiFailure: ReleaseFetcher = () =>
      Promise.resolve(json({ message: 'Forbidden' }, HTTP_FORBIDDEN));
    expect(
      await runPromise(flip(inspectGithubRelease(input(apiFailure)))),
    ).toMatchObject({ _tag: 'GithubApiError' });
    const transportFailure: ReleaseFetcher = () =>
      Promise.reject(new Error('network down'));
    expect(
      await runPromise(flip(inspectGithubRelease(input(transportFailure)))),
    ).toMatchObject({
      _tag: 'GithubApiError',
      message: 'GitHub API request failed: Error: network down',
    });
  });
});
