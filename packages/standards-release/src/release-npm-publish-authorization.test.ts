import { expect, it } from 'bun:test';
import { effectVoid, flip, runPromise, succeed } from './release-effect';
import type { ReleaseFetcher } from './release-github-request';
import { publishAuthorizedNpmArtifact } from './release-npm-publish';

const DEFAULT_BRANCH = 'default_branch';
const MERGE_BASE_COMMIT = 'merge_base_commit';

it('blocks npm when the remote diverges while the artifact is staged', async () => {
  const calls: Array<string> = [];
  let staged = false;
  let published = false;
  const fetcher: ReleaseFetcher = (requestInput) => {
    const path = new URL(String(requestInput)).pathname;
    calls.push(path);
    if (path === '/repos/owner/repo') {
      return Promise.resolve(Response.json({ [DEFAULT_BRANCH]: 'main' }));
    }
    return Promise.resolve(
      Response.json({
        [MERGE_BASE_COMMIT]: { sha: staged ? 'other' : 'expected' },
        status: staged ? 'diverged' : 'ahead',
      }),
    );
  };

  expect(
    await runPromise(
      flip(
        publishAuthorizedNpmArtifact(
          {
            apiUrl: 'https://github.test',
            artifact: 'package.tgz',
            expectedIntegrity: 'sha512-expected',
            expectedSha: 'expected',
            fetcher,
            repo: 'owner/repo',
            token: 'token',
          },
          () => {
            published = true;
            return effectVoid;
          },
          (input) => {
            calls.push('verify staged artifact');
            staged = true;
            return succeed(input.expectedIntegrity ?? '');
          },
          () => {
            calls.push('read source artifact');
            return succeed(new TextEncoder().encode('verified package bytes'));
          },
        ),
      ),
    ),
  ).toMatchObject({ _tag: 'GithubStateError' });
  expect(published).toBeFalse();
  expect(calls).toEqual([
    'read source artifact',
    'verify staged artifact',
    '/repos/owner/repo',
    '/repos/owner/repo/compare/expected...main',
  ]);
});
