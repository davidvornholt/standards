import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { flip, runPromise } from './release-effect';
import type { ReleaseFetcher } from './release-github-request';
import { publishAuthorizedNpmArtifact } from './release-npm-publish';
import { env, file, spawnSync, write } from './release-runtime';

const DEFAULT_BRANCH = 'default_branch';
const MERGE_BASE_COMMIT = 'merge_base_commit';
const ENVIRONMENT_KEYS = [
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'CAPTURE_ARGUMENTS',
  'CAPTURE_ENVIRONMENT',
  'FAKE_NPM_MODE',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'PATH',
] as const;

const originalEnvironment = Object.fromEntries(
  ENVIRONMENT_KEYS.map((key) => [key, env[key]]),
);
const directories: Array<string> = [];

const restoreEnvironment = () => {
  for (const key of ENVIRONMENT_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
};

beforeEach(restoreEnvironment);
afterEach(() => {
  restoreEnvironment();
  for (const directory of directories.splice(0)) {
    spawnSync(['rm', '-rf', directory]);
  }
});

const authorize: ReleaseFetcher = (requestInput) => {
  const path = new URL(String(requestInput)).pathname;
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

const createFakeNpm = async () => {
  const directory = spawnSync(['mktemp', '-d', '/tmp/fake-npm-XXXXXX'])
    .stdout.toString()
    .trim();
  directories.push(directory);
  const executable = `${directory}/npm`;
  await write(
    executable,
    `#!/bin/sh
printf '%s\\n' "$0" "$@" > "$CAPTURE_ARGUMENTS"
printf 'PATH=%s\\n' "$PATH" > "$CAPTURE_ENVIRONMENT"
printf 'OIDC_TOKEN=%s\\n' "$ACTIONS_ID_TOKEN_REQUEST_TOKEN" >> "$CAPTURE_ENVIRONMENT"
printf 'OIDC_URL=%s\\n' "$ACTIONS_ID_TOKEN_REQUEST_URL" >> "$CAPTURE_ENVIRONMENT"
if [ "\${GH_TOKEN+x}" = x ]; then printf 'GH_TOKEN=present\\n' >> "$CAPTURE_ENVIRONMENT"; else printf 'GH_TOKEN=absent\\n' >> "$CAPTURE_ENVIRONMENT"; fi
if [ "\${GITHUB_TOKEN+x}" = x ]; then printf 'GITHUB_TOKEN=present\\n' >> "$CAPTURE_ENVIRONMENT"; else printf 'GITHUB_TOKEN=absent\\n' >> "$CAPTURE_ENVIRONMENT"; fi
if [ "$FAKE_NPM_MODE" = stderr ]; then printf 'registry rejected\\n' >&2; exit 9; fi
if [ "$FAKE_NPM_MODE" = silent ]; then exit 7; fi
`,
  );
  const chmod = spawnSync(['chmod', '700', executable]);
  if (chmod.exitCode !== 0) {
    throw new Error(chmod.stderr.toString());
  }
  return { directory, executable };
};

const publish = (artifact = 'package artifact.tgz') =>
  publishAuthorizedNpmArtifact({
    apiUrl: 'https://github.test',
    artifact,
    expectedSha: 'expected',
    fetcher: authorize,
    repo: 'owner/repo',
    token: 'api-token',
  });

describe('production npm publisher', () => {
  it('executes exact arguments with OIDC inputs and without GitHub tokens', async () => {
    const fake = await createFakeNpm();
    const argumentsPath = `${fake.directory}/arguments`;
    const environmentPath = `${fake.directory}/environment`;
    Object.assign(
      env,
      Object.fromEntries([
        ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'oidc-token'],
        ['ACTIONS_ID_TOKEN_REQUEST_URL', 'https://oidc.test'],
        ['CAPTURE_ARGUMENTS', argumentsPath],
        ['CAPTURE_ENVIRONMENT', environmentPath],
        ['GH_TOKEN', 'api-token'],
        ['GITHUB_TOKEN', 'fallback-token'],
        ['PATH', fake.directory],
      ]),
    );

    await runPromise(publish());

    expect(
      (await file(argumentsPath).text()).split('\n').filter(Boolean),
    ).toEqual([
      fake.executable,
      'publish',
      'package artifact.tgz',
      '--ignore-scripts',
      '--provenance',
      '--access',
      'public',
      '--tag',
      'latest',
      '--registry=https://registry.npmjs.org',
    ]);
    expect(await file(environmentPath).text()).toBe(
      `PATH=${fake.directory}\nOIDC_TOKEN=oidc-token\nOIDC_URL=https://oidc.test\nGH_TOKEN=absent\nGITHUB_TOKEN=absent\n`,
    );
  });

  it('reports nonzero stderr and the exit-code fallback', async () => {
    const fake = await createFakeNpm();
    env.PATH = fake.directory;
    env.CAPTURE_ARGUMENTS = `${fake.directory}/arguments`;
    env.CAPTURE_ENVIRONMENT = `${fake.directory}/environment`;
    env.FAKE_NPM_MODE = 'stderr';
    expect(await runPromise(flip(publish()))).toMatchObject({
      _tag: 'NpmRegistryError',
      message: 'Publishing npm artifact failed: registry rejected',
    });

    env.FAKE_NPM_MODE = 'silent';
    expect(await runPromise(flip(publish()))).toMatchObject({
      _tag: 'NpmRegistryError',
      message: 'Publishing npm artifact failed: exit 7',
    });
  });

  it('reports a subprocess startup failure', async () => {
    const fake = await createFakeNpm();
    env.PATH = `${fake.directory}/missing`;
    expect(await runPromise(flip(publish()))).toMatchObject({
      _tag: 'NpmRegistryError',
      message: expect.stringContaining(
        'Publishing npm artifact failed while starting npm',
      ),
    });
  });
});
