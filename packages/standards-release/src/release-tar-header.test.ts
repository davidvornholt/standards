import { afterEach, describe, expect, it } from 'bun:test';
import { flip, runPromise } from './release-effect';
import { releasePackageTestEnvironment } from './release-package.fixture';
import { rewriteReleaseTar } from './release-package-tar';
import { spawnSync } from './release-runtime';
import {
  CHECKSUM_LENGTH,
  CHECKSUM_OFFSET,
  createTarTestArchive,
  refreshTarChecksum,
  SIZE_LENGTH,
  SIZE_OFFSET,
  unterminatedChecksum,
  writeTarField,
} from './release-tar-test-fixture';

const SHA_LENGTH = 40;
const EXPECTED_SHA = 'a'.repeat(SHA_LENGTH);
const OCTAL_RADIX = 8;
const testEnvironment = releasePackageTestEnvironment();

afterEach(() => {
  testEnvironment.cleanup();
});

describe('release tar numeric fields', () => {
  it('rejects malformed size and checksum field grammars', async () => {
    const { archive: baseline, artifact } = await createTarTestArchive(
      testEnvironment,
      'tar-number',
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
      writeTarField(
        archive,
        malformed.offset,
        malformed.length,
        malformed.value,
      );
      if (malformed.refresh) {
        refreshTarChecksum(archive);
      }
      return archive;
    });
    const unterminatedSize = baseline.slice();
    writeTarField(
      unterminatedSize,
      SIZE_OFFSET,
      SIZE_LENGTH,
      manifestSize.toString(OCTAL_RADIX).padStart(SIZE_LENGTH, '0'),
    );
    refreshTarChecksum(unterminatedSize);
    malformedArchives.push(unterminatedSize);
    const checksumWithoutTerminator = baseline.slice();
    unterminatedChecksum(checksumWithoutTerminator);
    malformedArchives.push(checksumWithoutTerminator);
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
