import { expect, it } from 'bun:test';
import { flip, runPromise } from './release-effect';
import { reconcileGithubRelease } from './release-github';
import { input, remote } from './release-github-test-fixture';

const MALFORMED_BRANCH = 7;

it('fails closed when either GitHub mutation loses fresh authorization', async () => {
  const beforeTag = remote(
    { release: 'absent', tagSha: null },
    { authorizationFailure: 1 },
  );
  expect(
    await runPromise(flip(reconcileGithubRelease(input(beforeTag.fetcher)))),
  ).toMatchObject({ _tag: 'GithubApiError' });
  expect(beforeTag.calls).not.toContain('POST /repos/owner/repo/git/refs');

  const beforeRelease = remote(
    { release: 'absent', tagSha: null },
    { authorizationFailure: 2 },
  );
  expect(
    await runPromise(
      flip(reconcileGithubRelease(input(beforeRelease.fetcher))),
    ),
  ).toMatchObject({ _tag: 'GithubApiError' });
  expect(beforeRelease.calls).toContain('POST /repos/owner/repo/git/refs');
  expect(beforeRelease.calls).not.toContain('POST /repos/owner/repo/releases');
});

it('fails closed when either mutation sees a renamed or malformed trailing identity', async () => {
  const results = await Promise.all(
    ['renamed', MALFORMED_BRANCH].map(async (trailingBranch) => {
      const beforeTag = remote(
        { release: 'absent', tagSha: null },
        { authorizationTrailingBranches: [trailingBranch] },
      );
      const tagFailure = await runPromise(
        flip(reconcileGithubRelease(input(beforeTag.fetcher))),
      );
      const beforeRelease = remote(
        { release: 'absent', tagSha: null },
        { authorizationTrailingBranches: ['main', trailingBranch] },
      );
      const releaseFailure = await runPromise(
        flip(reconcileGithubRelease(input(beforeRelease.fetcher))),
      );
      return {
        beforeRelease,
        beforeTag,
        releaseFailure,
        tagFailure,
        trailingBranch,
      };
    }),
  );
  for (const result of results) {
    const expectedTag =
      typeof result.trailingBranch === 'string'
        ? 'GithubStateError'
        : 'GithubApiError';
    expect(result.tagFailure).toMatchObject({ _tag: expectedTag });
    expect(result.beforeTag.calls).not.toContain(
      'POST /repos/owner/repo/git/refs',
    );
    expect(result.releaseFailure).toMatchObject({ _tag: expectedTag });
    expect(result.beforeRelease.calls).toContain(
      'POST /repos/owner/repo/git/refs',
    );
    expect(result.beforeRelease.calls).not.toContain(
      'POST /repos/owner/repo/releases',
    );
  }
});
