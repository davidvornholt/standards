import { expect, it } from 'bun:test';
import { effectVoid, flip, runPromise, succeed } from './release-effect';
import type { ReleaseFetcher } from './release-github-request';
import { publishAuthorizedNpmArtifact } from './release-npm-publish';

const DEFAULT_BRANCH = 'default_branch';
const MERGE_BASE_COMMIT = 'merge_base_commit';
const MALFORMED_BRANCH = 7;
const fixtureBytes = new TextEncoder().encode('verified package bytes');

const verifyFixture = (input: { readonly expectedIntegrity?: string }) =>
  succeed(input.expectedIntegrity ?? '');

const readFixture = () => succeed(fixtureBytes);

it('stages and verifies before final authorization and publication', async () => {
  const calls: Array<string> = [];
  const fetcher: ReleaseFetcher = (requestInput) => {
    const path = new URL(String(requestInput)).pathname;
    calls.push(path);
    return Promise.resolve(
      Response.json(
        path === '/repos/owner/repo'
          ? { [DEFAULT_BRANCH]: 'main' }
          : {
              [MERGE_BASE_COMMIT]: { sha: 'expected' },
              status: 'ahead',
            },
      ),
    );
  };

  await runPromise(
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
        calls.push('publish');
        return effectVoid;
      },
      (input) => {
        calls.push(`verify ${input.expectedIntegrity} ${input.expectedSha}`);
        return succeed(input.expectedIntegrity ?? '');
      },
      (artifact) => {
        calls.push(`read ${artifact}`);
        return succeed(fixtureBytes);
      },
    ),
  );

  expect(calls).toEqual([
    'read package.tgz',
    'verify sha512-expected expected',
    '/repos/owner/repo',
    '/repos/owner/repo/compare/expected...main',
    '/repos/owner/repo',
    '/repos/owner/repo/compare/expected...main',
    'publish',
  ]);
});

it('does not invoke npm when live default-branch authorization fails', async () => {
  let published = false;
  const fetcher: ReleaseFetcher = (requestInput) => {
    const path = new URL(String(requestInput)).pathname;
    return Promise.resolve(
      path === '/repos/owner/repo'
        ? Response.json({ [DEFAULT_BRANCH]: 'main' })
        : Response.json({ message: 'default branch changed' }, { status: 409 }),
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
          verifyFixture,
          readFixture,
        ),
      ),
    ),
  ).toMatchObject({ _tag: 'GithubApiError' });
  expect(published).toBeFalse();
});

it('does not invoke npm after a renamed or malformed trailing default branch', async () => {
  const results = await Promise.all(
    ['renamed', MALFORMED_BRANCH].map(async (trailingBranch) => {
      let published = false;
      let repositoryReads = 0;
      const fetcher: ReleaseFetcher = (requestInput) => {
        const path = new URL(String(requestInput)).pathname;
        if (path === '/repos/owner/repo') {
          repositoryReads += 1;
          return Promise.resolve(
            Response.json({
              [DEFAULT_BRANCH]: repositoryReads === 1 ? 'main' : trailingBranch,
            }),
          );
        }
        return Promise.resolve(
          Response.json({
            [MERGE_BASE_COMMIT]: { sha: 'expected' },
            status: 'ahead',
          }),
        );
      };

      const failure = await runPromise(
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
            verifyFixture,
            readFixture,
          ),
        ),
      );
      return { failure, published, trailingBranch };
    }),
  );
  for (const { failure, published, trailingBranch } of results) {
    expect(failure).toMatchObject({
      _tag:
        typeof trailingBranch === 'string'
          ? 'GithubStateError'
          : 'GithubApiError',
    });
    expect(published).toBeFalse();
  }
});
