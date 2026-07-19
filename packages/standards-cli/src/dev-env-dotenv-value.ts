const EMPTY_EXPANSION = ['$', '{:-}'].join('');
const QUOTED_BACKSLASH_HAZARD = /\\(?:[nr]|\r|\n)/u;
const EDGE_BACKSLASH = /\\$/u;
const UNQUOTED_BODY_HAZARD = /[#\r\n]/u;
const EDGE_DOLLAR = /\$$/u;
const EDGE_WHITESPACE = /\s$/u;

const escapeDollars = (value: string): string => value.replaceAll('$', '\\$');

const terminalDollarExpansion = (value: string): string =>
  EDGE_DOLLAR.test(value) ? EMPTY_EXPANSION : '';

const encodeUnquoted = (value: string): string | null => {
  if (UNQUOTED_BODY_HAZARD.test(value)) {
    return null;
  }
  const terminator =
    EDGE_WHITESPACE.test(value) || EDGE_DOLLAR.test(value)
      ? EMPTY_EXPANSION
      : '#';
  return `${EMPTY_EXPANSION}${escapeDollars(value)}${terminator}`;
};

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
    .replaceAll('\n', '\\n')}${terminalDollarExpansion(value)}"`;
};

const encodeLiteralQuoted = (
  value: string,
  delimiter: "'" | '`',
): string | null =>
  value.includes(delimiter) ||
  value.includes('\r') ||
  EDGE_BACKSLASH.test(value)
    ? null
    : `${delimiter}${escapeDollars(value)}${terminalDollarExpansion(value)}${delimiter}`;

export const encodeBunDotenvValue = (value: string): string | null =>
  encodeUnquoted(value) ??
  encodeDoubleQuoted(value) ??
  encodeLiteralQuoted(value, "'") ??
  encodeLiteralQuoted(value, '`');
