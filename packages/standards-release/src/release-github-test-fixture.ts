import type { ReleaseFetcher } from './release-github';

type RemoteState = {
  release: 'absent' | 'draft' | 'prerelease' | 'published';
  tagSha: string | null;
};

const HTTP_CREATED = 201;
const HTTP_NOT_FOUND = 404;
const HTTP_OK = 200;
const HTTP_UNPROCESSABLE = 422;
const HTTP_UNEXPECTED = 500;
const HTTP_CONFLICT = 409;
const DEFAULT_BRANCH = 'default_branch';
const MERGE_BASE_COMMIT = 'merge_base_commit';
export const RELEASE_NOTES_FIELD = 'generate_release_notes';
export const TAG_NAME_FIELD = 'tag_name';
export const TARGET_COMMIT_FIELD = 'target_commitish';

const json = (body: unknown, status: number): Response =>
  Response.json(body, { status });

export const remote = (
  state: RemoteState,
  options: {
    readonly authorizationFailure?: 1 | 2;
    readonly releaseRace?: boolean;
    readonly tagRaceSha?: string | null;
  } = {},
) => {
  const calls: Array<string> = [];
  const bodies: Array<unknown> = [];
  let authorizationCount = 0;
  const readResponse = (path: string): Response => {
    if (path === '/repos/owner/repo') {
      return json({ [DEFAULT_BRANCH]: 'main' }, HTTP_OK);
    }
    if (path.endsWith('/compare/expected...main')) {
      authorizationCount += 1;
      if (authorizationCount === options.authorizationFailure) {
        return json({ message: 'default branch changed' }, HTTP_CONFLICT);
      }
      return json(
        { [MERGE_BASE_COMMIT]: { sha: 'expected' }, status: 'ahead' },
        HTTP_OK,
      );
    }
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
    return Promise.resolve(
      method === 'GET'
        ? readResponse(url.pathname)
        : writeResponse(url.pathname),
    );
  };
  return { bodies, calls, fetcher };
};

export const input = (fetcher: ReleaseFetcher) => ({
  apiUrl: 'https://github.test',
  expectedSha: 'expected',
  fetcher,
  repo: 'owner/repo',
  tag: 'v0.5.0',
  token: 'token',
});
