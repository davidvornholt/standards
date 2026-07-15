import { describe, expect, it } from 'bun:test';
import { flip, runPromise } from './release-effect';
import {
  inspectGithubRelease,
  type ReleaseFetcher,
  reconcileGithubRelease,
} from './release-github';
import {
  input,
  RELEASE_NOTES_FIELD,
  remote,
  TAG_NAME_FIELD,
  TARGET_COMMIT_FIELD,
} from './release-github-test-fixture';

const HTTP_FORBIDDEN = 403;
const HTTP_CREATED = 201;
const AUTHORIZATION_REQUESTS = 4;

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
    expect(
      state.calls.slice(createTag - AUTHORIZATION_REQUESTS, createTag),
    ).toEqual([
      'GET /repos/owner/repo',
      'GET /repos/owner/repo/compare/expected...main',
      'GET /repos/owner/repo',
      'GET /repos/owner/repo/compare/expected...main',
    ]);
    expect(
      state.calls.slice(createRelease - AUTHORIZATION_REQUESTS, createRelease),
    ).toEqual([
      'GET /repos/owner/repo',
      'GET /repos/owner/repo/compare/expected...main',
      'GET /repos/owner/repo',
      'GET /repos/owner/repo/compare/expected...main',
    ]);
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
});

describe('GitHub release creation failures', () => {
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

  it('fails closed on unexpected tag and release creation statuses', async () => {
    const tagFailure = remote(
      { release: 'absent', tagSha: null },
      { tagCreateStatus: HTTP_FORBIDDEN },
    );
    expect(
      await runPromise(flip(reconcileGithubRelease(input(tagFailure.fetcher)))),
    ).toMatchObject({
      _tag: 'GithubStateError',
      message: 'Creating GitHub tag: HTTP 403 tag creation failed',
    });
    expect(tagFailure.calls).not.toContain('POST /repos/owner/repo/releases');

    const releaseFailure = remote(
      { release: 'absent', tagSha: 'expected' },
      { releaseCreateStatus: HTTP_FORBIDDEN },
    );
    expect(
      await runPromise(
        flip(reconcileGithubRelease(input(releaseFailure.fetcher))),
      ),
    ).toMatchObject({
      _tag: 'GithubStateError',
      message: 'Creating GitHub release: HTTP 403 release creation failed',
    });
  });

  it('rejects successful creation responses with absent final readback', async () => {
    const absentTag = remote(
      { release: 'absent', tagSha: null },
      { tagCreateReadbackSha: null, tagCreateStatus: HTTP_CREATED },
    );
    expect(
      await runPromise(flip(reconcileGithubRelease(input(absentTag.fetcher)))),
    ).toMatchObject({
      _tag: 'GithubStateError',
      message: 'GitHub tag v0.5.0 is still absent after creation',
    });
    expect(absentTag.calls).not.toContain('POST /repos/owner/repo/releases');

    const absentRelease = remote(
      { release: 'absent', tagSha: 'expected' },
      { releaseCreateReadback: false, releaseCreateStatus: HTTP_CREATED },
    );
    expect(
      await runPromise(
        flip(reconcileGithubRelease(input(absentRelease.fetcher))),
      ),
    ).toMatchObject({
      _tag: 'GithubStateError',
      message: 'GitHub release was not published after creation',
    });
  });
});

describe('GitHub release state failures', () => {
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
      Promise.resolve(
        Response.json({ message: 'Forbidden' }, { status: HTTP_FORBIDDEN }),
      );
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
