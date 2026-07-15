import { afterAll, beforeAll, expect, it } from 'bun:test';
import { authenticatePublishedArtifact } from './release-artifact-reproduction';
import { runPromise } from './release-effect';
import {
  createReleaseNpmTestFixture,
  type ReleaseNpmTestFixture,
} from './release-npm-test-fixture';
import { env, file, spawnSync, write } from './release-runtime';

let fixture: ReleaseNpmTestFixture;
const originalGitDirectory = env.GIT_DIR;

beforeAll(async () => {
  fixture = await createReleaseNpmTestFixture();
});

afterAll(async () => {
  env.GIT_DIR = originalGitDirectory;
  await fixture.dispose();
});

const git = (repository: string, args: ReadonlyArray<string>): string => {
  const result = spawnSync(
    ['git', '-C', repository, '-c', 'commit.gpgsign=false', ...args],
    {
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString().trim();
};

const bytes = async (path: string): Promise<Uint8Array> =>
  new Uint8Array(await file(path).arrayBuffer());

it('reproduces from the configured repository despite inherited GIT_DIR', async () => {
  const victim = `${fixture.directory}/git-environment-victim`;
  expect(
    spawnSync(['mkdir', victim], { stderr: 'pipe', stdout: 'pipe' }).exitCode,
  ).toBe(0);
  await write(`${victim}/victim.txt`, 'victim unchanged\n');
  git(victim, ['init', '--quiet', '-b', 'main']);
  git(victim, ['config', 'user.email', 'release@example.test']);
  git(victim, ['config', 'user.name', 'Release test']);
  git(victim, ['add', 'victim.txt']);
  git(victim, ['commit', '--quiet', '-m', 'victim']);
  const victimGit = `${victim}/.git`;
  const before = {
    config: await bytes(`${victimGit}/config`),
    head: await bytes(`${victimGit}/HEAD`),
    index: await bytes(`${victimGit}/index`),
    status: git(victim, ['status', '--porcelain']),
  };
  const downloadedBytes = await bytes(fixture.artifact);
  const releaseSha = await (async () => {
    env.GIT_DIR = victimGit;
    try {
      return await runPromise(
        authenticatePublishedArtifact({
          candidateSha: fixture.publishedSha,
          currentSha: fixture.currentSha,
          downloadedBytes,
          expectedIntegrity: fixture.integrity,
          repositoryPath: fixture.repository,
          temporaryDirectory: fixture.temporaryDirectory,
        }),
      );
    } finally {
      env.GIT_DIR = originalGitDirectory;
    }
  })();

  expect(releaseSha).toBe(fixture.publishedSha);

  expect(await bytes(`${victimGit}/config`)).toEqual(before.config);
  expect(await bytes(`${victimGit}/HEAD`)).toEqual(before.head);
  expect(await bytes(`${victimGit}/index`)).toEqual(before.index);
  expect(git(victim, ['status', '--porcelain'])).toBe(before.status);
  expect(await file(`${victim}/victim.txt`).text()).toBe('victim unchanged\n');
});
