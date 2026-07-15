import { afterEach, describe, expect, it } from 'bun:test';
import { flip, runPromise } from './release-effect';
import { rewriteReleaseTar } from './release-package-tar';
import { releasePackageTestEnvironment } from './release-package-test-fixture';
import { file, nodeGunzipSync, spawnSync, write } from './release-runtime';
import {
  createTarTestArchive,
  DEVICE_MAJOR_OFFSET,
  DEVICE_MINOR_OFFSET,
  GID_OFFSET,
  GROUP_NAME_OFFSET,
  HEADER_PADDING_OFFSET,
  LINK_NAME_OFFSET,
  LONG_NUMERIC_LENGTH,
  MAGIC_OFFSET,
  MODE_OFFSET,
  MTIME_OFFSET,
  PREFIX_OFFSET,
  refreshTarChecksum,
  SHORT_NUMERIC_LENGTH,
  TAR_BLOCK_SIZE,
  TYPE_OFFSET,
  UID_OFFSET,
  USER_NAME_OFFSET,
  VERSION_OFFSET,
  writeTarField,
} from './release-tar-test-fixture';

const SHA_LENGTH = 40;
const EXACT_WIDTH_NAME_LENGTH = 92;
const EXPECTED_SHA = 'a'.repeat(SHA_LENGTH);
const NAME_TERMINATOR_OFFSET = 'package/package.json'.length;
const testEnvironment = releasePackageTestEnvironment();

afterEach(() => {
  testEnvironment.cleanup();
});

const invalidResults = (archives: ReadonlyArray<Uint8Array>) =>
  Promise.all(
    archives.map((archive) =>
      runPromise(flip(rewriteReleaseTar(archive, EXPECTED_SHA))),
    ),
  );

describe('release tar USTAR dialect', () => {
  it('accepts real Bun pack output and an exact-width name', async () => {
    const { archive } = await createTarTestArchive(
      testEnvironment,
      'tar-format',
    );
    expect(
      await runPromise(rewriteReleaseTar(archive, EXPECTED_SHA)),
    ).toBeInstanceOf(Uint8Array);

    const packagePath = testEnvironment.temporaryDirectory(
      'tar-full-name-package',
    );
    const destination = testEnvironment.temporaryDirectory(
      'tar-full-name-artifact',
    );
    const name = 'a'.repeat(EXACT_WIDTH_NAME_LENGTH);
    await Promise.all([
      write(`${packagePath}/${name}`, 'x'),
      write(
        `${packagePath}/package.json`,
        JSON.stringify({
          files: [name],
          name: '@test/full-name',
          version: '1.0.0',
        }),
      ),
    ]);
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
    const fullNameArchive = nodeGunzipSync(
      new Uint8Array(await file(artifact).arrayBuffer()),
    );
    expect(
      await runPromise(rewriteReleaseTar(fullNameArchive, EXPECTED_SHA)),
    ).toBeInstanceOf(Uint8Array);
  });

  it('rejects unsupported headers and malformed text terminators', async () => {
    const { archive: baseline } = await createTarTestArchive(
      testEnvironment,
      'tar-header-format',
    );
    const changes = [
      { length: 6, offset: MAGIC_OFFSET, value: 'ustar ' },
      { length: 2, offset: VERSION_OFFSET, value: '01' },
      { length: 1, offset: TYPE_OFFSET, value: '5' },
      { length: SHORT_NUMERIC_LENGTH, offset: MODE_OFFSET, value: 'invalid!' },
      { length: SHORT_NUMERIC_LENGTH, offset: UID_OFFSET, value: 'invalid!' },
      { length: SHORT_NUMERIC_LENGTH, offset: GID_OFFSET, value: 'invalid!' },
      {
        length: LONG_NUMERIC_LENGTH,
        offset: MTIME_OFFSET,
        value: 'invalid!!!!!',
      },
      {
        length: SHORT_NUMERIC_LENGTH,
        offset: DEVICE_MAJOR_OFFSET,
        value: 'invalid!',
      },
      {
        length: SHORT_NUMERIC_LENGTH,
        offset: DEVICE_MINOR_OFFSET,
        value: 'invalid!',
      },
      { length: 1, offset: LINK_NAME_OFFSET + 1, value: 'x' },
      { length: 1, offset: USER_NAME_OFFSET + 1, value: 'x' },
      { length: 1, offset: GROUP_NAME_OFFSET + 1, value: 'x' },
      { length: 1, offset: NAME_TERMINATOR_OFFSET + 1, value: 'x' },
      { length: 1, offset: PREFIX_OFFSET + 1, value: 'x' },
      { length: 1, offset: HEADER_PADDING_OFFSET, value: 'x' },
    ] as const;
    const malformed = changes.map((change) => {
      const archive = baseline.slice();
      writeTarField(archive, change.offset, change.length, change.value);
      refreshTarChecksum(archive);
      return archive;
    });
    const failures = await invalidResults(malformed);
    expect(
      failures.every((failure) => failure._tag === 'ReleasePackageError'),
    ).toBeTrue();
  });

  it('rejects nonzero content padding and non-exact terminal blocks', async () => {
    const { archive: baseline, artifact } = await createTarTestArchive(
      testEnvironment,
      'tar-padding',
    );
    const manifestSize = spawnSync([
      'tar',
      '-xOzf',
      artifact,
      'package/package.json',
    ]).stdout.length;
    const contentPadding = baseline.slice();
    contentPadding[TAR_BLOCK_SIZE + manifestSize] = 1;
    const nonzeroEnd = baseline.slice();
    nonzeroEnd[nonzeroEnd.length - 1] = 1;
    const trailingBlock = new Uint8Array(baseline.length + TAR_BLOCK_SIZE);
    trailingBlock.set(baseline);
    const failures = await invalidResults([
      contentPadding,
      nonzeroEnd,
      trailingBlock,
    ]);
    expect(
      failures.every((failure) => failure._tag === 'ReleasePackageError'),
    ).toBeTrue();
  });
});
