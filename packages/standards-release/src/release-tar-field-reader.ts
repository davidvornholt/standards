const OCTAL_RADIX = 8;
const numericFieldPattern = /^ *(?<digits>[0-7]+)(?:\0 *| +\0?)$/u;
const decoder = new TextDecoder();

export const readTarOctal = (
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

export const isZeroTarRange = (
  bytes: Uint8Array,
  offset: number,
  end: number,
): boolean => {
  for (let index = offset; index < end; index += 1) {
    if (bytes[index] !== 0) {
      return false;
    }
  }
  return true;
};

export const readTarText = (
  bytes: Uint8Array,
  offset: number,
  length: number,
): string | null => {
  const field = bytes.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  if (terminator >= 0 && !isZeroTarRange(field, terminator, field.length)) {
    return null;
  }
  return decoder.decode(terminator < 0 ? field : field.subarray(0, terminator));
};

export const hasExactTarBytes = (
  bytes: Uint8Array,
  offset: number,
  expected: Uint8Array,
): boolean => expected.every((byte, index) => bytes[offset + index] === byte);
