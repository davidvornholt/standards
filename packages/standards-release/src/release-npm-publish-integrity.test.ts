import { afterEach, expect, it } from 'bun:test';
import { effectVoid, flip, runPromise } from './release-effect';
import type { ReleaseFetcher } from './release-github-request';
import { npmIntegrity } from './release-npm';
import { publishAuthorizedNpmArtifact } from './release-npm-publish';
import { packReleaseArtifact } from './release-package';
import {
  createReleasePackage,
  releasePackageTestEnvironment,
} from './release-package.fixture';
import { file, write } from './release-runtime';

const DEFAULT_BRANCH = 'default_branch';
const MERGE_BASE_COMMIT = 'merge_base_commit';
const SHA_LENGTH = 40;
const EXPECTED_SHA = 'a'.repeat(SHA_LENGTH);
const testEnvironment = releasePackageTestEnvironment();

afterEach(testEnvironment.cleanup);

const authorize: ReleaseFetcher = (requestInput) => {
  const path = new URL(String(requestInput)).pathname;
  return Promise.resolve(
    Response.json(
      path === '/repos/owner/repo'
        ? { [DEFAULT_BRANCH]: 'main' }
        : {
            [MERGE_BASE_COMMIT]: { sha: EXPECTED_SHA },
            status: 'ahead',
          },
    ),
  );
};

it('does not invoke npm when the packed artifact is replaced before publish', async () => {
  const originalPackage = testEnvironment.temporaryDirectory(
    'release-publish-original-package',
  );
  const replacementPackage = testEnvironment.temporaryDirectory(
    'release-publish-replacement-package',
  );
  const originalDestination = testEnvironment.temporaryDirectory(
    'release-publish-original-artifact',
  );
  const replacementDestination = testEnvironment.temporaryDirectory(
    'release-publish-replacement-artifact',
  );
  await Promise.all([
    createReleasePackage(originalPackage),
    createReleasePackage(replacementPackage),
  ]);
  await write(
    `${replacementPackage}/index.js`,
    'export const replacement = "unreviewed";\n',
  );
  const [artifact, replacement] = await Promise.all([
    runPromise(
      packReleaseArtifact({
        destination: originalDestination,
        expectedSha: EXPECTED_SHA,
        packagePath: originalPackage,
      }),
    ),
    runPromise(
      packReleaseArtifact({
        destination: replacementDestination,
        expectedSha: EXPECTED_SHA,
        packagePath: replacementPackage,
      }),
    ),
  ]);
  const expectedIntegrity = await runPromise(npmIntegrity(artifact));
  await write(artifact, await file(replacement).arrayBuffer());
  let published = false;

  const failure = await runPromise(
    flip(
      publishAuthorizedNpmArtifact(
        {
          apiUrl: 'https://github.test',
          artifact,
          expectedIntegrity,
          expectedSha: EXPECTED_SHA,
          fetcher: authorize,
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

  expect(failure).toMatchObject({
    _tag: 'ArtifactIdentityError',
    message: expect.stringContaining('does not match expected'),
  });
  expect(published).toBeFalse();
});
