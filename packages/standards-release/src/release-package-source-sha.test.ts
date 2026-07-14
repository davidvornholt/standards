import { afterEach, expect, it } from 'bun:test';
import { spawnSync } from 'bun';
import { flip, runPromise } from './release-effect';
import { packReleaseArtifact, SOURCE_COMMIT_FILE } from './release-package';
import {
  createReleasePackage,
  releasePackageTestEnvironment,
} from './release-package.fixture';
import { file } from './release-runtime';

const SHA_LENGTH = 40;
const testEnvironment = releasePackageTestEnvironment();

afterEach(() => {
  testEnvironment.cleanup();
});

it('rejects invalid source SHAs before spawning or writing an artifact', async () => {
  const packagePath = testEnvironment.temporaryDirectory(
    'release-package-invalid-sha',
  );
  const destination = testEnvironment.temporaryDirectory(
    'release-artifact-invalid-sha',
  );
  await createReleasePackage(packagePath);
  const invalidShas = [
    'a'.repeat(SHA_LENGTH - 1),
    'A'.repeat(SHA_LENGTH),
    `${'a'.repeat(SHA_LENGTH - 1)}g`,
  ];

  const failures = await Promise.all(
    invalidShas.map((expectedSha) =>
      runPromise(
        flip(packReleaseArtifact({ destination, expectedSha, packagePath })),
      ),
    ),
  );

  expect(
    failures.map((failure) => ({
      _tag: failure._tag,
      message: failure.message,
    })),
  ).toEqual(
    invalidShas.map((expectedSha) => ({
      _tag: 'ReleasePackageError',
      message: `Packing release artifact requires a full lowercase commit SHA; received ${expectedSha}`,
    })),
  );
  expect(
    spawnSync([
      'find',
      destination,
      '-mindepth',
      '1',
      '-print',
    ]).stdout.toString(),
  ).toBe('');
  expect(await file(`${packagePath}/${SOURCE_COMMIT_FILE}`).exists()).toBe(
    false,
  );
});
