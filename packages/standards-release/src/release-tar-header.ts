import {
  hasExactTarBytes,
  isZeroTarRange,
  readTarOctal,
  readTarText,
} from './release-tar-field-reader';

const OCTAL_RADIX = 8;
const NAME_OFFSET = 0;
const NAME_LENGTH = 100;
const MODE_OFFSET = 100;
const UID_OFFSET = 108;
const GID_OFFSET = 116;
const SIZE_OFFSET = 124;
const MTIME_OFFSET = 136;
const CHECKSUM_OFFSET = 148;
const CHECKSUM_END = 156;
const TYPE_OFFSET = 156;
const LINK_NAME_OFFSET = 157;
const MAGIC_OFFSET = 257;
const VERSION_OFFSET = 263;
const USER_NAME_OFFSET = 265;
const GROUP_NAME_OFFSET = 297;
const DEVICE_MAJOR_OFFSET = 329;
const DEVICE_MINOR_OFFSET = 337;
const PREFIX_OFFSET = 345;
const PREFIX_LENGTH = 155;
const HEADER_PADDING_OFFSET = 500;
const SHORT_FIELD_LENGTH = 8;
const LONG_FIELD_LENGTH = 12;
const CHECKSUM_LENGTH = 8;
const CHECKSUM_DIGITS = 6;
const MAGIC_LENGTH = 6;
const OWNER_NAME_LENGTH = 32;
const FILE_MODE = 0o644;
const ASCII_SPACE = 0x20;
const REGULAR_FILE_TYPE = 0x30;
const encoder = new TextEncoder();
const USTAR_MAGIC = encoder.encode('ustar\0');
const USTAR_VERSION = encoder.encode('00');
const EMPTY_TEXT_FIELDS = [
  [LINK_NAME_OFFSET, NAME_LENGTH],
  [USER_NAME_OFFSET, OWNER_NAME_LENGTH],
  [GROUP_NAME_OFFSET, OWNER_NAME_LENGTH],
] as const;
const NUMERIC_FIELDS = [
  [MODE_OFFSET, SHORT_FIELD_LENGTH],
  [UID_OFFSET, SHORT_FIELD_LENGTH],
  [GID_OFFSET, SHORT_FIELD_LENGTH],
  [MTIME_OFFSET, LONG_FIELD_LENGTH],
  [DEVICE_MAJOR_OFFSET, SHORT_FIELD_LENGTH],
  [DEVICE_MINOR_OFFSET, SHORT_FIELD_LENGTH],
] as const;

export const TAR_BLOCK_SIZE = 512;
export const TAR_END_BLOCKS = 2;

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

const writeOctal = (
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void => {
  writeText(target, offset, length, octal(value, length));
};

const writeChecksum = (header: Uint8Array): void => {
  header.fill(ASCII_SPACE, CHECKSUM_OFFSET, CHECKSUM_END);
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
};

const hasValidChecksum = (bytes: Uint8Array, offset: number): boolean => {
  const expected = readTarOctal(
    bytes,
    offset + CHECKSUM_OFFSET,
    CHECKSUM_LENGTH,
  );
  if (expected === null) {
    return false;
  }
  let actual = 0;
  for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
    actual +=
      index >= CHECKSUM_OFFSET && index < CHECKSUM_END
        ? ASCII_SPACE
        : (bytes[offset + index] ?? 0);
  }
  return actual === expected;
};

export const isZeroTarBlock = (bytes: Uint8Array, offset: number): boolean =>
  isZeroTarRange(bytes, offset, offset + TAR_BLOCK_SIZE);

export const parseTarHeader = (
  bytes: Uint8Array,
  offset: number,
): { readonly name: string; readonly size: number } | null => {
  if (
    offset + TAR_BLOCK_SIZE > bytes.length ||
    !hasValidChecksum(bytes, offset) ||
    bytes[offset + TYPE_OFFSET] !== REGULAR_FILE_TYPE ||
    !hasExactTarBytes(bytes, offset + MAGIC_OFFSET, USTAR_MAGIC) ||
    !hasExactTarBytes(bytes, offset + VERSION_OFFSET, USTAR_VERSION) ||
    !EMPTY_TEXT_FIELDS.every(
      ([fieldOffset, length]) =>
        readTarText(bytes, offset + fieldOffset, length) === '',
    ) ||
    !NUMERIC_FIELDS.every(
      ([fieldOffset, length]) =>
        readTarOctal(bytes, offset + fieldOffset, length) !== null,
    ) ||
    !isZeroTarRange(
      bytes,
      offset + HEADER_PADDING_OFFSET,
      offset + TAR_BLOCK_SIZE,
    )
  ) {
    return null;
  }
  const size = readTarOctal(bytes, offset + SIZE_OFFSET, LONG_FIELD_LENGTH);
  if (size === null) {
    return null;
  }
  const name = readTarText(bytes, offset + NAME_OFFSET, NAME_LENGTH);
  const prefix = readTarText(bytes, offset + PREFIX_OFFSET, PREFIX_LENGTH);
  if (name === null || name === '' || prefix === null) {
    return null;
  }
  return { name: prefix === '' ? name : `${prefix}/${name}`, size };
};

export const resizeTarHeader = (
  original: Uint8Array,
  size: number,
): Uint8Array => {
  const header = original.slice(0, TAR_BLOCK_SIZE);
  writeOctal(header, SIZE_OFFSET, LONG_FIELD_LENGTH, size);
  writeChecksum(header);
  return header;
};

export const createTarHeader = (name: string, size: number): Uint8Array => {
  const header = new Uint8Array(TAR_BLOCK_SIZE);
  writeText(header, NAME_OFFSET, NAME_LENGTH, name);
  writeOctal(header, MODE_OFFSET, SHORT_FIELD_LENGTH, FILE_MODE);
  writeOctal(header, UID_OFFSET, SHORT_FIELD_LENGTH, 0);
  writeOctal(header, GID_OFFSET, SHORT_FIELD_LENGTH, 0);
  writeOctal(header, SIZE_OFFSET, LONG_FIELD_LENGTH, size);
  writeOctal(header, MTIME_OFFSET, LONG_FIELD_LENGTH, 0);
  writeOctal(header, DEVICE_MAJOR_OFFSET, SHORT_FIELD_LENGTH, 0);
  writeOctal(header, DEVICE_MINOR_OFFSET, SHORT_FIELD_LENGTH, 0);
  writeText(header, TYPE_OFFSET, 1, '0');
  writeText(header, MAGIC_OFFSET, MAGIC_LENGTH, 'ustar\0');
  writeText(header, VERSION_OFFSET, TAR_END_BLOCKS, '00');
  writeChecksum(header);
  return header;
};
