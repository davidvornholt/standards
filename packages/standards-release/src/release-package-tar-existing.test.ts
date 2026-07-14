import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'bun';
import { flip, runPromise } from './release-effect';
import { SOURCE_COMMIT_FILE } from './release-package';
import {
  createReleasePackage,
  releasePackageTestEnvironment,
} from './release-package.fixture';
import { rewritePackedArtifact } from './release-package-rewrite';
import { file, write } from './release-runtime';

const SHA_LENGTH = 40;
const EXPECTED_SHA = 'a'.repeat(SHA_LENGTH);
const testEnvironment = releasePackageTestEnvironment();

afterEach(() => {
  testEnvironment.cleanup();
});

describe('release package tar existing marker', () => {
  it('refuses an existing archive marker without rewriting the artifact', async () => {
    const packagePath = testEnvironment.temporaryDirectory(
      'release-tar-existing-package',
    );
    const destination = testEnvironment.temporaryDirectory(
      'release-tar-existing-artifact',
    );
    await createReleasePackage(packagePath);
    const sourceMarker = `${packagePath}/${SOURCE_COMMIT_FILE}`;
    await write(sourceMarker, '');
    const artifact = spawnSync([
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
    const before = new Uint8Array(await file(artifact).arrayBuffer());

    expect(
      await runPromise(
        flip(rewritePackedArtifact({ artifact, expectedSha: EXPECTED_SHA })),
      ),
    ).toMatchObject({
      _tag: 'ReleasePackageError',
      message: expect.stringContaining(
        'refused existing archive entry package/SOURCE_COMMIT',
      ),
    });
    expect(new Uint8Array(await file(artifact).arrayBuffer())).toEqual(before);
    expect(await file(sourceMarker).text()).toBe('');
    expect(
      spawnSync(['tar', '-tzf', artifact])
        .stdout.toString()
        .split('\n')
        .filter((name) => name === 'package/SOURCE_COMMIT'),
    ).toEqual(['package/SOURCE_COMMIT']);
  });

  it('reports an artifact rewrite write failure as a tagged error', async () => {
    const packagePath = testEnvironment.temporaryDirectory(
      'release-tar-write-package',
    );
    const destination = testEnvironment.temporaryDirectory(
      'release-tar-write-artifact',
    );
    await createReleasePackage(packagePath);
    const artifact = spawnSync([
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
    spawnSync(['chmod', '444', artifact]);
    expect(
      await runPromise(
        flip(rewritePackedArtifact({ artifact, expectedSha: EXPECTED_SHA })),
      ),
    ).toMatchObject({
      _tag: 'ReleasePackageError',
      message: expect.stringContaining('writing the source-bound artifact'),
    });
  });
});
