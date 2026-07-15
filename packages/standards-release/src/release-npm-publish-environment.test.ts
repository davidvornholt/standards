import { expect, it } from 'bun:test';
import {
  npmPublishCommand,
  npmPublishEnvironment,
} from './release-npm-publish';

const ACTIONS_ID_TOKEN = 'ACTIONS_ID_TOKEN_REQUEST_TOKEN';
const ACTIONS_ID_URL = 'ACTIONS_ID_TOKEN_REQUEST_URL';
const PATH = 'PATH';

it('uses trusted publishing inputs without exposing the GitHub API token', () => {
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
        ['GH_TOKEN', 'api-token'],
        ['GITHUB_TOKEN', 'fallback-token'],
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
