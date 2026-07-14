import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'bun';
import { flip, runPromise } from './release-effect';
import { npmIntegrity } from './release-npm';
import {
  packReleaseArtifact,
  SOURCE_COMMIT_FILE,
  verifyArtifactSourceCommit,
} from './release-package';
import { file, write } from './release-runtime';

const SHA_LENGTH = 40;
const EXPECTED_SHA = 'a'.repeat(SHA_LENGTH);
const MISMATCHED_SHA = 'b'.repeat(SHA_LENGTH);
const directories: Array<string> = [];
const releasePackageSource = await file(
  `${import.meta.dir}/release-package.ts`,
).text();
const releasePackageMarkerSource = await file(
  `${import.meta.dir}/release-package-marker.ts`,
).text();

const temporaryDirectory = (label: string): string => {
  const directory = spawnSync(['mktemp', '-d', `/tmp/${label}-XXXXXX`])
    .stdout.toString()
    .trim();
  directories.push(directory);
  return directory;
};

const createPackage = (directory: string): Promise<number> =>
  Promise.all([
    write(
      `${directory}/package.json`,
      JSON.stringify({
        files: ['index.js', SOURCE_COMMIT_FILE],
        name: '@test/release-artifact',
        version: '1.0.0',
      }),
    ),
    write(`${directory}/index.js`, 'export const value = true;\n'),
  ]).then(([manifestBytes]) => manifestBytes);

afterEach(() => {
  for (const directory of directories.splice(0)) {
    spawnSync(['rm', '-rf', directory]);
  }
});

describe('release package', () => {
  it('keeps packing application logic inside the Effect boundary', () => {
    const boundarySource = `${releasePackageSource}\n${releasePackageMarkerSource}`;
    expect(boundarySource).toContain('acquireUseReleaseTyped(');
    expect(boundarySource).toContain('tryPromise({');
    expect(boundarySource).toContain("{ flag: 'wx' }");
    for (const forbidden of [
      ': Promise<',
      'Promise.all(',
      '.then(',
      '.finally(',
      'new Error(',
      'orDie',
      'async ',
    ]) {
      expect(boundarySource).not.toContain(forbidden);
    }
  });

  it('packs a deterministic source-bound artifact and cleans the marker', async () => {
    const packagePath = temporaryDirectory('release-package');
    const firstDestination = temporaryDirectory('release-artifact-first');
    const secondDestination = temporaryDirectory('release-artifact-second');
    await createPackage(packagePath);
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
    const packagePath = temporaryDirectory('release-package-existing');
    const destination = temporaryDirectory('release-artifact-existing');
    await createPackage(packagePath);
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
  it('cleans a generated marker when packing fails', async () => {
    const packagePath = temporaryDirectory('release-package-invalid');
    const destination = temporaryDirectory('release-artifact-invalid');
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
    const packagePath = temporaryDirectory('release-package-unmarked');
    const destination = temporaryDirectory('release-artifact-unmarked');
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

    await createPackage(packagePath);
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
