export type CharacterMatcher =
  | { readonly kind: 'literal'; readonly value: number }
  | { readonly kind: 'non-slash' }
  | {
      readonly kind: 'class';
      readonly ranges: ReadonlyArray<readonly [number, number]>;
      readonly negated: boolean;
    };

type CharacterRange = readonly [number, number];

const BEFORE_SLASH = '/'.codePointAt(0) ?? 0;
const AFTER_SLASH = BEFORE_SLASH + 1;
const MAXIMUM_CODE_POINT = 0x10_ff_ff;

const NON_SLASH_RANGES: ReadonlyArray<CharacterRange> = [
  [0, BEFORE_SLASH - 1],
  [AFTER_SLASH, MAXIMUM_CODE_POINT],
];

const intersectRanges = (
  left: ReadonlyArray<CharacterRange>,
  right: ReadonlyArray<CharacterRange>,
): ReadonlyArray<CharacterRange> => {
  const intersection: Array<CharacterRange> = [];
  for (const [leftStart, leftEnd] of left) {
    for (const [rightStart, rightEnd] of right) {
      const start = Math.max(leftStart, rightStart);
      const end = Math.min(leftEnd, rightEnd);
      if (start <= end) {
        intersection.push([start, end]);
      }
    }
  }
  return intersection;
};

const subtractRanges = (
  ranges: ReadonlyArray<CharacterRange>,
  excluded: ReadonlyArray<CharacterRange>,
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Range subtraction keeps the finite character-class intersection exact.
): ReadonlyArray<CharacterRange> => {
  let remaining = [...ranges];
  for (const [excludedStart, excludedEnd] of excluded) {
    const next: Array<CharacterRange> = [];
    for (const [start, end] of remaining) {
      if (excludedEnd < start || excludedStart > end) {
        next.push([start, end]);
      } else {
        if (start < excludedStart) {
          next.push([start, excludedStart - 1]);
        }
        if (excludedEnd < end) {
          next.push([excludedEnd + 1, end]);
        }
      }
    }
    remaining = next;
  }
  return remaining;
};

const matcherRanges = (
  matcher: CharacterMatcher,
): ReadonlyArray<CharacterRange> => {
  if (matcher.kind === 'literal') {
    return [[matcher.value, matcher.value]];
  }
  if (matcher.kind === 'non-slash') {
    return NON_SLASH_RANGES;
  }
  return matcher.negated
    ? subtractRanges(NON_SLASH_RANGES, matcher.ranges)
    : intersectRanges(NON_SLASH_RANGES, matcher.ranges);
};

export const matchersIntersect = (
  left: CharacterMatcher,
  right: CharacterMatcher,
): boolean =>
  intersectRanges(matcherRanges(left), matcherRanges(right)).length > 0;

export const parseCharacterClass = (
  characters: ReadonlyArray<string>,
  start: number,
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Ruby character classes require escape, negation, and range state in one parser.
): { readonly end: number; readonly matcher: CharacterMatcher } | null => {
  let cursor = start + 1;
  const negated = characters[cursor] === '!' || characters[cursor] === '^';
  if (negated) {
    cursor += 1;
  }
  const values: Array<number> = [];
  if (characters[cursor] === ']') {
    values.push(']'.codePointAt(0) ?? 0);
    cursor += 1;
  }
  for (
    ;
    cursor < characters.length && characters[cursor] !== ']';
    cursor += 1
  ) {
    if (characters[cursor] === '\\' && characters[cursor + 1] !== undefined) {
      cursor += 1;
    }
    values.push(characters[cursor]?.codePointAt(0) ?? 0);
  }
  if (characters[cursor] !== ']') {
    return null;
  }
  const ranges: Array<CharacterRange> = [];
  for (let index = 0; index < values.length; index += 1) {
    if (index + 2 < values.length && values[index + 1] === '-'.codePointAt(0)) {
      ranges.push([values[index] ?? 0, values[index + 2] ?? 0]);
      index += 2;
    } else {
      const value = values[index] ?? 0;
      ranges.push([value, value]);
    }
  }
  return { end: cursor, matcher: { kind: 'class', ranges, negated } };
};
