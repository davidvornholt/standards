import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'bun';
import { flip, runPromise } from './release-effect';
import { packReleaseArtifact, SOURCE_COMMIT_FILE } from './release-package';
import {
  createReleasePackage,
  releasePackageTestEnvironment,
} from './release-package-test-fixture';

const SHA_LENGTH = 40;
const EXPECTED_SHA = 'a'.repeat(SHA_LENGTH);
const testEnvironment = releasePackageTestEnvironment();

afterEach(() => {
  testEnvironment.cleanup();
});

const refused = (packagePath: string, destination: string) =>
  runPromise(
    flip(
      packReleaseArtifact({
        destination,
        expectedSha: EXPECTED_SHA,
        packagePath,
      }),
    ),
  );

describe('release package source marker namespace', () => {
  it('preserves a pre-existing marker directory', async () => {
    const packagePath = testEnvironment.temporaryDirectory(
      'release-package-marker-directory',
    );
    const destination = testEnvironment.temporaryDirectory(
      'release-artifact-marker-directory',
    );
    await createReleasePackage(packagePath);
    const marker = `${packagePath}/${SOURCE_COMMIT_FILE}`;
    spawnSync(['mkdir', marker]);
    expect(await refused(packagePath, destination)).toMatchObject({
      _tag: 'ReleasePackageError',
    });
    expect(spawnSync(['test', '-d', marker]).exitCode).toBe(0);
  });

  it('preserves a pre-existing dangling marker symlink', async () => {
    const packagePath = testEnvironment.temporaryDirectory(
      'release-package-marker-symlink',
    );
    const destination = testEnvironment.temporaryDirectory(
      'release-artifact-marker-symlink',
    );
    await createReleasePackage(packagePath);
    const marker = `${packagePath}/${SOURCE_COMMIT_FILE}`;
    spawnSync(['ln', '-s', 'missing-target', marker]);
    expect(await refused(packagePath, destination)).toMatchObject({
      _tag: 'ReleasePackageError',
    });
    expect(spawnSync(['readlink', marker]).stdout.toString().trim()).toBe(
      'missing-target',
    );
  });
});
