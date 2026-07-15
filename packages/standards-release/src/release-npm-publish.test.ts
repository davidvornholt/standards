import { expect, it } from 'bun:test';
import { effectVoid, flip, runPromise, succeed } from './release-effect';
import type { ReleaseFetcher } from './release-github-request';
import {
  npmPublishCommand,
  npmPublishEnvironment,
  publishAuthorizedNpmArtifact,
} from './release-npm-publish';

const DEFAULT_BRANCH = 'default_branch';
const MERGE_BASE_COMMIT = 'merge_base_commit';
const ACTIONS_ID_TOKEN = 'ACTIONS_ID_TOKEN_REQUEST_TOKEN';
const ACTIONS_ID_URL = 'ACTIONS_ID_TOKEN_REQUEST_URL';
const PATH = 'PATH';
const MALFORMED_BRANCH = 7;

it('authorizes immediately inside the npm mutation owner', async () => {
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
      (artifact) => {
        calls.push(`publish ${artifact}`);
        return effectVoid;
      },
      (input) => {
        calls.push(
          `verify ${input.artifact} ${input.expectedIntegrity} ${input.expectedSha}`,
        );
        return succeed(input.expectedIntegrity ?? '');
      },
    ),
  );

  expect(calls).toEqual([
    '/repos/owner/repo',
    '/repos/owner/repo/compare/expected...main',
    '/repos/owner/repo',
    '/repos/owner/repo/compare/expected...main',
    'verify package.tgz sha512-expected expected',
    'publish package.tgz',
  ]);
});

it('preserves trusted publishing inputs without exposing the GitHub API token', () => {
  expect(npmPublishCommand('package.tgz')).toEqual([
    'npm',
    'publish',
    'package.tgz',
    '--ignore-scripts',
    '--provenance',
    '--access',
    'public',
    '--tag',
    'latest',
    '--registry=https://registry.npmjs.org',
  ]);
  expect(
    npmPublishEnvironment(
      Object.fromEntries([
        [ACTIONS_ID_TOKEN, 'oidc-token'],
        [ACTIONS_ID_URL, 'https://oidc.test'],
        ['GITHUB_TOKEN', 'fallback-token'],
        ['GH_TOKEN', 'api-token'],
        [PATH, '/usr/bin'],
        ['UNDEFINED_VALUE', undefined],
      ]),
    ),
  ).toEqual({
    [ACTIONS_ID_TOKEN]: 'oidc-token',
    [ACTIONS_ID_URL]: 'https://oidc.test',
    [PATH]: '/usr/bin',
  });
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
