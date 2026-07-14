import { fail, succeed } from './release-effect';
import { ReleasePackageError } from './release-package-error';

const BLOCK_SIZE = 512;
const END_BLOCKS = 2;
const MARKER_PATH = 'package/SOURCE_COMMIT';
const OCTAL_RADIX = 8;
const NAME_OFFSET = 0;
const NAME_LENGTH = 100;
const MODE_OFFSET = 100;
const UID_OFFSET = 108;
const GID_OFFSET = 116;
const SIZE_OFFSET = 124;
const MTIME_OFFSET = 136;
const CHECKSUM_OFFSET = 148;
const TYPE_OFFSET = 156;
const MAGIC_OFFSET = 257;
const VERSION_OFFSET = 263;
const PREFIX_OFFSET = 345;
const PREFIX_LENGTH = 155;
const SHORT_FIELD_LENGTH = 8;
const LONG_FIELD_LENGTH = 12;
const CHECKSUM_END = 156;
const CHECKSUM_LENGTH = 8;
const CHECKSUM_DIGITS = 6;
const MAGIC_LENGTH = 6;
const FILE_MODE = 0o644;
const ASCII_SPACE = 0x20;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const isZeroBlock = (bytes: Uint8Array, offset: number): boolean => {
  for (let index = offset; index < offset + BLOCK_SIZE; index += 1) {
    if (bytes[index] !== 0) {
      return false;
    }
  }
  return true;
};

const readOctal = (bytes: Uint8Array, offset: number, length: number) => {
  const text = decoder
    .decode(bytes.subarray(offset, offset + length))
    .replaceAll('\0', '')
    .trim();
  const value = Number.parseInt(text || '0', 8);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

const readText = (bytes: Uint8Array, offset: number, length: number): string =>
  decoder.decode(bytes.subarray(offset, offset + length)).split('\0', 1)[0] ??
  '';

const hasValidChecksum = (bytes: Uint8Array, offset: number): boolean => {
  const expected = readOctal(bytes, offset + CHECKSUM_OFFSET, CHECKSUM_LENGTH);
  if (expected === null) {
    return false;
  }
  let actual = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    actual +=
      index >= CHECKSUM_OFFSET && index < CHECKSUM_END
        ? ASCII_SPACE
        : (bytes[offset + index] ?? 0);
  }
  return actual === expected;
};

type TarScan = {
  readonly end: number;
  readonly hasSourceCommit: boolean;
};

const headerName = (bytes: Uint8Array, offset: number): string => {
  const name = readText(bytes, offset + NAME_OFFSET, NAME_LENGTH);
  const prefix = readText(bytes, offset + PREFIX_OFFSET, PREFIX_LENGTH);
  return prefix === '' ? name : `${prefix}/${name}`;
};

const scanTar = (bytes: Uint8Array): TarScan | null => {
  let offset = 0;
  let hasSourceCommit = false;
  while (offset + BLOCK_SIZE * END_BLOCKS <= bytes.length) {
    if (isZeroBlock(bytes, offset)) {
      return isZeroBlock(bytes, offset + BLOCK_SIZE)
        ? { end: offset, hasSourceCommit }
        : null;
    }
    if (!hasValidChecksum(bytes, offset)) {
      return null;
    }
    hasSourceCommit ||= headerName(bytes, offset) === MARKER_PATH;
    const size = readOctal(bytes, offset + SIZE_OFFSET, LONG_FIELD_LENGTH);
    if (size === null) {
      return null;
    }
    offset += BLOCK_SIZE + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }
  return null;
};

const writeText = (
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void => {
  target.set(encoder.encode(value).subarray(0, length), offset);
};

const octal = (value: number, length: number): string =>
  `${value.toString(OCTAL_RADIX).padStart(length - 1, '0')}\0`;

const markerHeader = (size: number): Uint8Array => {
  const header = new Uint8Array(BLOCK_SIZE);
  writeText(header, NAME_OFFSET, NAME_LENGTH, MARKER_PATH);
  writeText(
    header,
    MODE_OFFSET,
    SHORT_FIELD_LENGTH,
    octal(FILE_MODE, SHORT_FIELD_LENGTH),
  );
  writeText(
    header,
    UID_OFFSET,
    SHORT_FIELD_LENGTH,
    octal(0, SHORT_FIELD_LENGTH),
  );
  writeText(
    header,
    GID_OFFSET,
    SHORT_FIELD_LENGTH,
    octal(0, SHORT_FIELD_LENGTH),
  );
  writeText(
    header,
    SIZE_OFFSET,
    LONG_FIELD_LENGTH,
    octal(size, LONG_FIELD_LENGTH),
  );
  writeText(
    header,
    MTIME_OFFSET,
    LONG_FIELD_LENGTH,
    octal(0, LONG_FIELD_LENGTH),
  );
  header.fill(ASCII_SPACE, CHECKSUM_OFFSET, CHECKSUM_END);
  writeText(header, TYPE_OFFSET, 1, '0');
  writeText(header, MAGIC_OFFSET, MAGIC_LENGTH, 'ustar\0');
  writeText(header, VERSION_OFFSET, END_BLOCKS, '00');
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  writeText(
    header,
    CHECKSUM_OFFSET,
    CHECKSUM_LENGTH,
    `${checksum.toString(OCTAL_RADIX).padStart(CHECKSUM_DIGITS, '0')}\0 `,
  );
  return header;
};

export const appendSourceCommitTar = (
  archive: Uint8Array,
  expectedSha: string,
) => {
  const scan = scanTar(archive);
  if (scan === null) {
    return fail(
      new ReleasePackageError({
        message: 'Packing release artifact produced an invalid tar payload',
      }),
    );
  }
  if (scan.hasSourceCommit) {
    return fail(
      new ReleasePackageError({
        message: `Packing release artifact refused existing archive entry ${MARKER_PATH}`,
      }),
    );
  }
  const contents = encoder.encode(`${expectedSha}\n`);
  const contentBlocks = Math.ceil(contents.length / BLOCK_SIZE);
  const output = new Uint8Array(
    scan.end + BLOCK_SIZE * (1 + contentBlocks + END_BLOCKS),
  );
  output.set(archive.subarray(0, scan.end));
  output.set(markerHeader(contents.length), scan.end);
  output.set(contents, scan.end + BLOCK_SIZE);
  return succeed(output);
};
