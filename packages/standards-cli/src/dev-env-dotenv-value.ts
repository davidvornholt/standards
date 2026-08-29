const DOUBLE_QUOTED_BACKSLASH_HAZARD = /\\(?:[nr]|\r|\n)/u;
const EDGE_BACKSLASH = /\\$/u;
const EDGE_WHITESPACE = /^\s|\s$/u;
const PORTABLE_BODY_HAZARD = /[\0\r$]/u;
const UNQUOTED_BODY_HAZARD = /[#\n]/u;

const encodeUnquoted = (value: string): string | null => {
  if (
    PORTABLE_BODY_HAZARD.test(value) ||
    UNQUOTED_BODY_HAZARD.test(value) ||
    EDGE_WHITESPACE.test(value)
  ) {
    return null;
  }
  return value;
};

const encodeDoubleQuoted = (value: string): string | null => {
  if (
    value.includes('"') ||
    PORTABLE_BODY_HAZARD.test(value) ||
    EDGE_BACKSLASH.test(value) ||
    DOUBLE_QUOTED_BACKSLASH_HAZARD.test(value)
  ) {
    return null;
  }
  return `"${value}"`;
};

const encodeLiteralQuoted = (
  value: string,
  delimiter: "'" | '`',
): string | null =>
  value.includes(delimiter) ||
  PORTABLE_BODY_HAZARD.test(value) ||
  EDGE_BACKSLASH.test(value)
    ? null
    : `${delimiter}${value}${delimiter}`;

export const encodePortableDotenvValue = (value: string): string | null =>
  encodeUnquoted(value) ??
  encodeLiteralQuoted(value, "'") ??
  encodeLiteralQuoted(value, '`') ??
  encodeDoubleQuoted(value);
