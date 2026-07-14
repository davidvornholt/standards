import {
  createReleasePackage,
  type releasePackageTestEnvironment,
} from './release-package.fixture';
import { file, nodeGunzipSync, spawnSync } from './release-runtime';

export const TAR_BLOCK_SIZE = 512;
export const SIZE_OFFSET = 124;
export const SIZE_LENGTH = 12;
export const SHORT_NUMERIC_LENGTH = 8;
export const LONG_NUMERIC_LENGTH = 12;
export const MODE_OFFSET = 100;
export const UID_OFFSET = 108;
export const GID_OFFSET = 116;
export const MTIME_OFFSET = 136;
export const CHECKSUM_OFFSET = 148;
export const CHECKSUM_END = 156;
export const CHECKSUM_LENGTH = 8;
export const TYPE_OFFSET = 156;
export const LINK_NAME_OFFSET = 157;
export const MAGIC_OFFSET = 257;
export const VERSION_OFFSET = 263;
export const USER_NAME_OFFSET = 265;
export const GROUP_NAME_OFFSET = 297;
export const DEVICE_MAJOR_OFFSET = 329;
export const DEVICE_MINOR_OFFSET = 337;
export const PREFIX_OFFSET = 345;
export const HEADER_PADDING_OFFSET = 500;
const ASCII_SPACE = 0x20;
const OCTAL_RADIX = 8;
const CHECKSUM_DIGITS = 6;
const encoder = new TextEncoder();

type TestEnvironment = ReturnType<typeof releasePackageTestEnvironment>;

export const writeTarField = (
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

export const refreshTarChecksum = (archive: Uint8Array): void => {
  const checksum = headerChecksum(archive);
  writeTarField(
    archive,
    CHECKSUM_OFFSET,
    CHECKSUM_LENGTH,
    `${checksum.toString(OCTAL_RADIX).padStart(CHECKSUM_DIGITS, '0')}\0 `,
  );
};

export const unterminatedChecksum = (archive: Uint8Array): void => {
  const checksum = headerChecksum(archive);
  writeTarField(
    archive,
    CHECKSUM_OFFSET,
    CHECKSUM_LENGTH,
    checksum.toString(OCTAL_RADIX).padStart(CHECKSUM_LENGTH, '0'),
  );
};

export const createTarTestArchive = async (
  testEnvironment: TestEnvironment,
  label: string,
) => {
  const packagePath = testEnvironment.temporaryDirectory(`${label}-package`);
  const destination = testEnvironment.temporaryDirectory(`${label}-artifact`);
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
  const archive = nodeGunzipSync(
    new Uint8Array(await file(artifact).arrayBuffer()),
  );
  return { archive, artifact };
};
