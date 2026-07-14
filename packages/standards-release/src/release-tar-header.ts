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
const MAGIC_OFFSET = 257;
const VERSION_OFFSET = 263;
const PREFIX_OFFSET = 345;
const PREFIX_LENGTH = 155;
const SHORT_FIELD_LENGTH = 8;
const LONG_FIELD_LENGTH = 12;
const CHECKSUM_LENGTH = 8;
const CHECKSUM_DIGITS = 6;
const MAGIC_LENGTH = 6;
const FILE_MODE = 0o644;
const ASCII_SPACE = 0x20;
const numericFieldPattern = /^ *(?<digits>[0-7]+)(?:\0 *| +)$/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const TAR_BLOCK_SIZE = 512;
export const TAR_END_BLOCKS = 2;

const readOctal = (
  bytes: Uint8Array,
  offset: number,
  length: number,
): number | null => {
  const match = numericFieldPattern.exec(
    decoder.decode(bytes.subarray(offset, offset + length)),
  );
  if (match === null) {
    return null;
  }
  const value = Number.parseInt(match.groups?.digits ?? '', OCTAL_RADIX);
  return Number.isSafeInteger(value) ? value : null;
};

const readText = (bytes: Uint8Array, offset: number, length: number): string =>
  decoder.decode(bytes.subarray(offset, offset + length)).split('\0', 1)[0] ??
  '';

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
  const expected = readOctal(bytes, offset + CHECKSUM_OFFSET, CHECKSUM_LENGTH);
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

export const isZeroTarBlock = (bytes: Uint8Array, offset: number): boolean => {
  for (let index = offset; index < offset + TAR_BLOCK_SIZE; index += 1) {
    if (bytes[index] !== 0) {
      return false;
    }
  }
  return true;
};

export const parseTarHeader = (
  bytes: Uint8Array,
  offset: number,
): { readonly name: string; readonly size: number } | null => {
  if (!hasValidChecksum(bytes, offset)) {
    return null;
  }
  const size = readOctal(bytes, offset + SIZE_OFFSET, LONG_FIELD_LENGTH);
  if (size === null) {
    return null;
  }
  const name = readText(bytes, offset + NAME_OFFSET, NAME_LENGTH);
  const prefix = readText(bytes, offset + PREFIX_OFFSET, PREFIX_LENGTH);
  return { name: prefix === '' ? name : `${prefix}/${name}`, size };
};

export const resizeTarHeader = (
  original: Uint8Array,
  size: number,
): Uint8Array => {
  const header = original.slice(0, TAR_BLOCK_SIZE);
  writeText(
    header,
    SIZE_OFFSET,
    LONG_FIELD_LENGTH,
    octal(size, LONG_FIELD_LENGTH),
  );
  writeChecksum(header);
  return header;
};

export const createTarHeader = (name: string, size: number): Uint8Array => {
  const header = new Uint8Array(TAR_BLOCK_SIZE);
  writeText(header, NAME_OFFSET, NAME_LENGTH, name);
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
  writeText(header, TYPE_OFFSET, 1, '0');
  writeText(header, MAGIC_OFFSET, MAGIC_LENGTH, 'ustar\0');
  writeText(header, VERSION_OFFSET, TAR_END_BLOCKS, '00');
  writeChecksum(header);
  return header;
};
