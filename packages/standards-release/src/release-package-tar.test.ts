import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'bun';
import { flip, runPromise } from './release-effect';
import { packReleaseArtifact, SOURCE_COMMIT_FILE } from './release-package';
import {
  createReleasePackage,
  releasePackageTestEnvironment,
} from './release-package.fixture';
import { rewritePackedArtifact } from './release-package-rewrite';
import { appendSourceCommitTar } from './release-package-tar';
import { file, nodeGunzipSync } from './release-runtime';

const SHA_LENGTH = 40;
const TAR_BLOCK_SIZE = 512;
const EXPECTED_SHA = 'a'.repeat(SHA_LENGTH);
const testEnvironment = releasePackageTestEnvironment();
const releasePackageSource = await file(
  `${import.meta.dir}/release-package.ts`,
).text();
const releasePackageTarSource = await file(
  `${import.meta.dir}/release-package-tar.ts`,
).text();
const releasePackageRewriteSource = await file(
  `${import.meta.dir}/release-package-rewrite.ts`,
).text();
const markerHeaderOffset = (archive: Uint8Array): number => {
  const marker = new TextEncoder().encode('package/SOURCE_COMMIT');
  for (let offset = 0; offset < archive.length; offset += TAR_BLOCK_SIZE) {
    if (marker.every((byte, index) => archive[offset + index] === byte)) {
      return offset;
    }
  }
  return -1;
};

afterEach(() => {
  testEnvironment.cleanup();
});

describe('release package tar rewrite', () => {
  it('keeps packing application logic inside the Effect boundary', () => {
    const boundarySource = `${releasePackageSource}\n${releasePackageTarSource}\n${releasePackageRewriteSource}`;
    expect(boundarySource).toContain('nodeLstat(marker)');
    expect(boundarySource).toContain('nodeGzipSync(');
    expect(boundarySource).toContain('tryPromise({');
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
});

describe('release package tar contents', () => {
  it('adds only the exact marker and preserves public package entries', async () => {
    const packagePath = testEnvironment.temporaryDirectory(
      'release-tar-package',
    );
    const destination = testEnvironment.temporaryDirectory(
      'release-tar-artifact',
    );
    const baselineDestination = testEnvironment.temporaryDirectory(
      'release-tar-baseline',
    );
    await createReleasePackage(packagePath, { publicTree: true });
    const sourceManifest = await file(`${packagePath}/package.json`).text();
    const baselineArtifact = spawnSync([
      'bun',
      'pm',
      'pack',
      '--cwd',
      packagePath,
      '--destination',
      baselineDestination,
      '--ignore-scripts',
      '--quiet',
    ])
      .stdout.toString()
      .trim();
    const baselineManifest = spawnSync([
      'tar',
      '-xOzf',
      baselineArtifact,
      'package/package.json',
    ]).stdout.toString();
    const artifact = await runPromise(
      packReleaseArtifact({
        destination,
        expectedSha: EXPECTED_SHA,
        packagePath,
      }),
    );
    const archiveFiles = spawnSync(['tar', '-tzf', artifact])
      .stdout.toString()
      .trim()
      .split('\n')
      .sort();
    expect(archiveFiles).toEqual(
      [
        'package/SOURCE_COMMIT',
        'package/index.js',
        'package/nested/public.js',
        'package/package.json',
      ].sort(),
    );
    expect(
      spawnSync([
        'tar',
        '-xOzf',
        artifact,
        'package/package.json',
      ]).stdout.toString(),
    ).toBe(baselineManifest);
    expect(JSON.parse(baselineManifest)).toMatchObject({
      gitHead: 'caller-owned-git-head',
    });
    expect(
      spawnSync([
        'tar',
        '-xOzf',
        artifact,
        'package/SOURCE_COMMIT',
      ]).stdout.toString(),
    ).toBe(`${EXPECTED_SHA}\n`);
    expect(await file(`${packagePath}/${SOURCE_COMMIT_FILE}`).exists()).toBe(
      false,
    );
    expect(await file(`${packagePath}/index.js`).text()).toBe(
      'export const value = true;\n',
    );
    expect(await file(`${packagePath}/package.json`).text()).toBe(
      sourceManifest,
    );
    const baselineTar = nodeGunzipSync(
      new Uint8Array(await file(baselineArtifact).arrayBuffer()),
    );
    const rewrittenTar = nodeGunzipSync(
      new Uint8Array(await file(artifact).arrayBuffer()),
    );
    const markerOffset = markerHeaderOffset(rewrittenTar);
    expect(markerOffset).toBeGreaterThan(0);
    expect(rewrittenTar.subarray(0, markerOffset)).toEqual(
      baselineTar.subarray(0, markerOffset),
    );
  });
});

describe('release package tar failures', () => {
  it('reports invalid payloads and artifact reads as typed failures', async () => {
    expect(
      await runPromise(
        flip(appendSourceCommitTar(new Uint8Array(), EXPECTED_SHA)),
      ),
    ).toMatchObject({ _tag: 'ReleasePackageError' });
    expect(
      await runPromise(
        flip(
          rewritePackedArtifact({
            artifact: '/missing/release-artifact.tgz',
            expectedSha: EXPECTED_SHA,
          }),
        ),
      ),
    ).toMatchObject({ _tag: 'ReleasePackageError' });
  });
});
