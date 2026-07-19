const EMPTY_EXPANSION = ['$', '{:-}'].join('');
const QUOTED_BACKSLASH_HAZARD = /\\(?:[nr]|\r|\n)/u;
const EDGE_BACKSLASH = /\\$/u;
const UNQUOTED_HAZARD = /[#\r\n]|\s$/u;

const escapeDollars = (value: string): string => value.replaceAll('$', '\\$');

const encodeUnquoted = (value: string): string | null =>
  UNQUOTED_HAZARD.test(value)
    ? null
    : `${EMPTY_EXPANSION}${escapeDollars(value)}#`;

const encodeDoubleQuoted = (value: string): string | null => {
  if (
    value.includes('"') ||
    EDGE_BACKSLASH.test(value) ||
    QUOTED_BACKSLASH_HAZARD.test(value)
  ) {
    return null;
  }
  return `"${escapeDollars(value)
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')}"`;
};

const encodeLiteralQuoted = (
  value: string,
  delimiter: "'" | '`',
): string | null =>
  value.includes(delimiter) ||
  value.includes('\r') ||
  EDGE_BACKSLASH.test(value)
    ? null
    : `${delimiter}${escapeDollars(value)}${delimiter}`;

export const encodeBunDotenvValue = (value: string): string | null =>
  encodeUnquoted(value) ??
  encodeDoubleQuoted(value) ??
  encodeLiteralQuoted(value, "'") ??
  encodeLiteralQuoted(value, '`');
