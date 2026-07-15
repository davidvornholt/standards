import { expect, it } from 'bun:test';
import { flip, runPromise } from './release-effect';
import { reconcileGithubRelease } from './release-github';
import { input, remote } from './release-github-test-fixture';

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
