import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'bun';
import { flip, runPromise } from './release-effect';
import {
  createReleasePackage,
  releasePackageTestEnvironment,
} from './release-package.fixture';
import { rewriteReleaseTar } from './release-package-tar';
import { file, nodeGunzipSync } from './release-runtime';

const SHA_LENGTH = 40;
const EXPECTED_SHA = 'a'.repeat(SHA_LENGTH);
const TAR_BLOCK_SIZE = 512;
const SIZE_OFFSET = 124;
const SIZE_LENGTH = 12;
const CHECKSUM_OFFSET = 148;
const CHECKSUM_END = 156;
const CHECKSUM_LENGTH = 8;
const ASCII_SPACE = 0x20;
const OCTAL_RADIX = 8;
const CHECKSUM_DIGITS = 6;
const testEnvironment = releasePackageTestEnvironment();
const encoder = new TextEncoder();

afterEach(() => {
  testEnvironment.cleanup();
});

const writeField = (
  archive: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void => {
  archive.fill(0, offset, offset + length);
  archive.set(encoder.encode(value), offset);
};

const headerChecksum = (archive: Uint8Array): number => {
  archive.fill(ASCII_SPACE, CHECKSUM_OFFSET, CHECKSUM_END);
  let checksum = 0;
  for (const byte of archive.subarray(0, TAR_BLOCK_SIZE)) {
    checksum += byte;
  }
  return checksum;
};

const refreshChecksum = (archive: Uint8Array): void => {
  const checksum = headerChecksum(archive);
  writeField(
    archive,
    CHECKSUM_OFFSET,
    CHECKSUM_LENGTH,
    `${checksum.toString(OCTAL_RADIX).padStart(CHECKSUM_DIGITS, '0')}\0 `,
  );
};

describe('release tar numeric fields', () => {
  it('rejects malformed size and checksum field grammars', async () => {
    const packagePath =
      testEnvironment.temporaryDirectory('tar-number-package');
    const destination = testEnvironment.temporaryDirectory(
      'tar-number-artifact',
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
    const baseline = nodeGunzipSync(
      new Uint8Array(await file(artifact).arrayBuffer()),
    );
    const manifestSize = spawnSync([
      'tar',
      '-xOzf',
      artifact,
      'package/package.json',
    ]).stdout.length;
    const cases = [
      {
        offset: SIZE_OFFSET,
        length: SIZE_LENGTH,
        value: '0000000001x\0',
        refresh: true,
      },
      {
        offset: SIZE_OFFSET,
        length: SIZE_LENGTH,
        value: '0000001\0 1\0',
        refresh: true,
      },
      {
        offset: CHECKSUM_OFFSET,
        length: CHECKSUM_LENGTH,
        value: '00001x\0 ',
        refresh: false,
      },
      {
        offset: CHECKSUM_OFFSET,
        length: CHECKSUM_LENGTH,
        value: '0001\0 1 ',
        refresh: false,
      },
    ] as const;
    const malformedArchives = cases.map((malformed) => {
      const archive = baseline.slice();
      writeField(archive, malformed.offset, malformed.length, malformed.value);
      if (malformed.refresh) {
        refreshChecksum(archive);
      }
      return archive;
    });
    const unterminatedSize = baseline.slice();
    writeField(
      unterminatedSize,
      SIZE_OFFSET,
      SIZE_LENGTH,
      manifestSize.toString(OCTAL_RADIX).padStart(SIZE_LENGTH, '0'),
    );
    refreshChecksum(unterminatedSize);
    malformedArchives.push(unterminatedSize);
    const unterminatedChecksum = baseline.slice();
    const checksum = headerChecksum(unterminatedChecksum);
    writeField(
      unterminatedChecksum,
      CHECKSUM_OFFSET,
      CHECKSUM_LENGTH,
      checksum.toString(OCTAL_RADIX).padStart(CHECKSUM_LENGTH, '0'),
    );
    malformedArchives.push(unterminatedChecksum);
    const failures = await Promise.all(
      malformedArchives.map((archive) =>
        runPromise(flip(rewriteReleaseTar(archive, EXPECTED_SHA))),
      ),
    );
    for (const failure of failures) {
      expect(failure).toMatchObject({ _tag: 'ReleasePackageError' });
    }
  });
});
