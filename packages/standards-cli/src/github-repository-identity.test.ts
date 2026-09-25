import { afterEach, expect, it } from 'bun:test';
import {
  ACCOUNT_A,
  cleanupCredsAdd,
  initializeConsumer,
  setConsumerOrigin,
} from './creds-add-test-support';
import { resolveGithubRepo } from './github-api';

afterEach(cleanupCredsAdd);

it.each([
  ['git@github.com:DavidVornholt/Example.git', 'davidvornholt/example'],
  ['https://github.com/DavidVornholt/Example.GIT.git', 'davidvornholt/example'],
  ['ssh://git@github.com/DavidVornholt/Example.git', 'davidvornholt/example'],
  ['git@github.com:Owner/.github.git', 'owner/.github'],
  ['https://github.com/Owner/.github.git', 'owner/.github'],
  ['https://github.com/Owner/_repo.git', 'owner/_repo'],
  ['https://github.com/owner/..', null],
  ['https://github.com/owner/exam ple.git', null],
  ['https://github.com/owner/example.git?ref=main', null],
  ['https://evilgithub.com/owner/example.git', null],
])('resolves repository custody for %s', (url, expected) => {
  const consumer = initializeConsumer([ACCOUNT_A]);
  setConsumerOrigin(consumer, url);
  expect(resolveGithubRepo(consumer)).toBe(expected);
});
