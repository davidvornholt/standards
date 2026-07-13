import { describe, expect, it } from 'bun:test';
import {
  inspectGithubRelease,
  type ReleaseFetcher,
  reconcileGithubRelease,
} from './release-github';

type RemoteState = {
  release: 'absent' | 'draft' | 'published';
  tagSha: string | null;
};

const HTTP_CREATED = 201;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_OK = 200;
const HTTP_UNPROCESSABLE = 422;
const HTTP_UNEXPECTED = 500;
const TAG_NAME_FIELD = 'tag_name';

const json = (body: unknown, status: number): Response =>
  Response.json(body, { status });

const remote = (
  state: RemoteState,
  options: {
    readonly releaseRace?: boolean;
    readonly tagRaceSha?: string;
  } = {},
): { readonly calls: Array<string>; readonly fetcher: ReleaseFetcher } => {
  const calls: Array<string> = [];
  const readResponse = (path: string): Response => {
    if (path.includes('/releases/tags/')) {
      return state.release === 'absent'
        ? json({ message: 'Not Found' }, HTTP_NOT_FOUND)
        : json({ draft: state.release === 'draft' }, HTTP_OK);
    }
    return state.tagSha === null
      ? json({ message: 'Not Found' }, HTTP_NOT_FOUND)
      : json({ object: { sha: state.tagSha, type: 'commit' } }, HTTP_OK);
  };
  const createTag = (): Response => {
    if (options.tagRaceSha !== undefined) {
      state.tagSha = options.tagRaceSha;
      return json({ message: 'Reference already exists' }, HTTP_UNPROCESSABLE);
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
    if (path.endsWith('/releases')) {
      return createRelease();
    }
    return json({ message: 'unexpected route' }, HTTP_UNEXPECTED);
  };
  const fetcher: ReleaseFetcher = (requestInput, init) => {
    const url = new URL(String(requestInput));
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}`);
    const response =
      method === 'GET'
        ? readResponse(url.pathname)
        : writeResponse(url.pathname);
    return Promise.resolve(response);
  };
  return { calls, fetcher };
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
    expect(await inspectGithubRelease(input(absent.fetcher))).toEqual({
      ok: true,
      value: 'create',
    });
    const existing = remote({ release: 'published', tagSha: 'expected' });
    expect(await inspectGithubRelease(input(existing.fetcher))).toEqual({
      ok: true,
      value: 'exists',
    });
  });

  it('creates and verifies a tag before creating the release', async () => {
    const state = remote({ release: 'absent', tagSha: null });
    expect(await reconcileGithubRelease(input(state.fetcher))).toEqual({
      ok: true,
      value: 'exists',
    });
    const createTag = state.calls.indexOf('POST /repos/owner/repo/git/refs');
    const createRelease = state.calls.indexOf(
      'POST /repos/owner/repo/releases',
    );
    expect(createTag).toBeGreaterThan(-1);
    expect(createRelease).toBeGreaterThan(createTag);
    expect(state.calls.slice(createTag + 1, createRelease)).toContain(
      'GET /repos/owner/repo/git/ref/tags/v0.5.0',
    );
  });

  it('accepts exact tag and release creation races idempotently', async () => {
    const tagRace = remote(
      { release: 'absent', tagSha: null },
      { tagRaceSha: 'expected' },
    );
    expect(await reconcileGithubRelease(input(tagRace.fetcher))).toEqual({
      ok: true,
      value: 'exists',
    });
    const releaseRace = remote(
      { release: 'absent', tagSha: 'expected' },
      { releaseRace: true },
    );
    expect(await reconcileGithubRelease(input(releaseRace.fetcher))).toEqual({
      ok: true,
      value: 'exists',
    });
  });

  it('rejects conflicting races, drafts, and missing published tags', async () => {
    const conflict = remote(
      { release: 'absent', tagSha: null },
      { tagRaceSha: 'other' },
    );
    expect(await reconcileGithubRelease(input(conflict.fetcher))).toEqual({
      error: 'Release tag points to other, expected expected',
      ok: false,
    });
    const draft = remote({ release: 'draft', tagSha: 'expected' });
    expect(await inspectGithubRelease(input(draft.fetcher))).toEqual({
      error: 'Release already exists as a draft',
      ok: false,
    });
    const missingTag = remote({ release: 'published', tagSha: null });
    expect(await inspectGithubRelease(input(missingTag.fetcher))).toEqual({
      error: 'Published release has no matching remote tag',
      ok: false,
    });
  });

  it('fails closed on API and transport errors', async () => {
    const apiFailure: ReleaseFetcher = () =>
      Promise.resolve(json({ message: 'Forbidden' }, HTTP_FORBIDDEN));
    expect(await inspectGithubRelease(input(apiFailure))).toEqual({
      error: 'Reading GitHub release: HTTP 403 Forbidden',
      ok: false,
    });
    const transportFailure: ReleaseFetcher = () =>
      Promise.reject(new Error('network down'));
    expect(await inspectGithubRelease(input(transportFailure))).toEqual({
      error: 'GitHub API request failed: Error: network down',
      ok: false,
    });
  });
});
