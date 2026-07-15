import { expect, it } from 'bun:test';
import { effectVoid, flip, runPromise } from './release-effect';
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
        expectedSha: 'expected',
        fetcher,
        repo: 'owner/repo',
        token: 'token',
      },
      (artifact) => {
        calls.push(`publish ${artifact}`);
        return effectVoid;
      },
    ),
  );

  expect(calls).toEqual([
    '/repos/owner/repo',
    '/repos/owner/repo/compare/expected...main',
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
