import { expect, it } from 'bun:test';
import { effectVoid, flip, runPromise } from './release-effect';
import type { ReleaseFetcher } from './release-github-request';
import { publishAuthorizedNpmArtifact } from './release-npm-publish';

const DEFAULT_BRANCH = 'default_branch';
const MERGE_BASE_COMMIT = 'merge_base_commit';

it('does not invoke npm after same-name head divergence', async () => {
  const calls: Array<string> = [];
  let comparisonReads = 0;
  let published = false;
  const fetcher: ReleaseFetcher = (requestInput) => {
    const path = new URL(String(requestInput)).pathname;
    calls.push(path);
    if (path === '/repos/owner/repo') {
      return Promise.resolve(Response.json({ [DEFAULT_BRANCH]: 'main' }));
    }
    comparisonReads += 1;
    return Promise.resolve(
      Response.json(
        comparisonReads === 1
          ? {
              [MERGE_BASE_COMMIT]: { sha: 'expected' },
              status: 'ahead',
            }
          : {
              [MERGE_BASE_COMMIT]: { sha: 'other' },
              status: 'diverged',
            },
      ),
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
        ),
      ),
    ),
  ).toMatchObject({ _tag: 'GithubStateError' });
  expect(published).toBeFalse();
  expect(calls).toEqual([
    '/repos/owner/repo',
    '/repos/owner/repo/compare/expected...main',
    '/repos/owner/repo',
    '/repos/owner/repo/compare/expected...main',
  ]);
});
