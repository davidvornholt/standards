import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'bun';
import { flip, runPromise } from './release-effect';
import { npmIntegrity } from './release-npm';
import {
  packReleaseArtifact,
  SOURCE_COMMIT_FILE,
  verifyArtifactSourceCommit,
} from './release-package';
import {
  createReleasePackage,
  releasePackageTestEnvironment,
} from './release-package.fixture';
import { file, write } from './release-runtime';

const SHA_LENGTH = 40;
const EXPECTED_SHA = 'a'.repeat(SHA_LENGTH);
const MISMATCHED_SHA = 'b'.repeat(SHA_LENGTH);
const testEnvironment = releasePackageTestEnvironment();

afterEach(() => {
  testEnvironment.cleanup();
});

describe('release package', () => {
  it('packs a deterministic source-bound artifact without touching the source', async () => {
    const packagePath = testEnvironment.temporaryDirectory('release-package');
    const firstDestination = testEnvironment.temporaryDirectory(
      'release-artifact-first',
    );
    const secondDestination = testEnvironment.temporaryDirectory(
      'release-artifact-second',
    );
    await createReleasePackage(packagePath);
    const first = await runPromise(
      packReleaseArtifact({
        destination: firstDestination,
        expectedSha: EXPECTED_SHA,
        packagePath,
      }),
    );
    const second = await runPromise(
      packReleaseArtifact({
        destination: secondDestination,
        expectedSha: EXPECTED_SHA,
        packagePath,
      }),
    );
    expect(await file(`${packagePath}/${SOURCE_COMMIT_FILE}`).exists()).toBe(
      false,
    );
    expect(await runPromise(npmIntegrity(first))).toBe(
      await runPromise(npmIntegrity(second)),
    );
    expect(
      await runPromise(
        verifyArtifactSourceCommit({
          artifact: first,
          expectedSha: EXPECTED_SHA,
        }),
      ),
    ).toBeUndefined();
  });

  it('preserves a pre-existing marker instead of overwriting it', async () => {
    const packagePath = testEnvironment.temporaryDirectory(
      'release-package-existing',
    );
    const destination = testEnvironment.temporaryDirectory(
      'release-artifact-existing',
    );
    await createReleasePackage(packagePath);
    const marker = `${packagePath}/${SOURCE_COMMIT_FILE}`;
    await write(marker, 'owned by caller\n');
    expect(
      await runPromise(
        flip(
          packReleaseArtifact({
            destination,
            expectedSha: EXPECTED_SHA,
            packagePath,
          }),
        ),
      ),
    ).toMatchObject({ _tag: 'ReleasePackageError' });
    expect(await file(marker).text()).toBe('owned by caller\n');
  });
});

describe('release package failures', () => {
  it('leaves the source marker absent when packing fails', async () => {
    const packagePath = testEnvironment.temporaryDirectory(
      'release-package-invalid',
    );
    const destination = testEnvironment.temporaryDirectory(
      'release-artifact-invalid',
    );
    expect(
      await runPromise(
        flip(
          packReleaseArtifact({
            destination,
            expectedSha: EXPECTED_SHA,
            packagePath,
          }),
        ),
      ),
    ).toMatchObject({ _tag: 'ReleasePackageError' });
    expect(await file(`${packagePath}/${SOURCE_COMMIT_FILE}`).exists()).toBe(
      false,
    );
  });

  it('rejects a missing or mismatched artifact source marker', async () => {
    const packagePath = testEnvironment.temporaryDirectory(
      'release-package-unmarked',
    );
    const destination = testEnvironment.temporaryDirectory(
      'release-artifact-unmarked',
    );
    await write(
      `${packagePath}/package.json`,
      JSON.stringify({ name: '@test/unmarked', version: '1.0.0' }),
    );
    const packed = spawnSync([
      'bun',
      'pm',
      'pack',
      '--cwd',
      packagePath,
      '--destination',
      destination,
      '--ignore-scripts',
      '--quiet',
    ])
      .stdout.toString()
      .trim();
    const missing = await runPromise(
      flip(
        verifyArtifactSourceCommit({
          artifact: packed,
          expectedSha: EXPECTED_SHA,
        }),
      ),
    );
    expect(missing).toMatchObject({ _tag: 'ArtifactIdentityError' });

    await createReleasePackage(packagePath);
    const marked = await runPromise(
      packReleaseArtifact({
        destination,
        expectedSha: EXPECTED_SHA,
        packagePath,
      }),
    );
    const mismatch = await runPromise(
      flip(
        verifyArtifactSourceCommit({
          artifact: marked,
          expectedSha: MISMATCHED_SHA,
        }),
      ),
    );
    expect(mismatch).toMatchObject({ _tag: 'ArtifactIdentityError' });
  });
});
