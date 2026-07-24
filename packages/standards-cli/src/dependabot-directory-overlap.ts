type DirectoryToken =
  | {
      readonly kind: 'literal';
      readonly value: string;
    }
  | {
      readonly kind: 'wildcard';
      readonly recursive: boolean;
    };

const tokenizeDirectory = (
  directory: string,
  supportsGlobs: boolean,
): ReadonlyArray<DirectoryToken> => {
  const tokens: Array<DirectoryToken> = [];
  const characters = [...directory];
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (supportsGlobs && character === '*') {
      const recursive = characters[index + 1] === '*';
      tokens.push({ kind: 'wildcard', recursive });
      if (recursive) {
        index += 1;
      }
    } else if (character !== undefined) {
      tokens.push({ kind: 'literal', value: character });
    }
  }
  return tokens;
};

const tokenAcceptsLiteral = (
  token: DirectoryToken,
  literal: string,
): boolean =>
  token.kind === 'literal'
    ? token.value === literal
    : token.recursive || literal !== '/';

const tokensCanConsumeTogether = (
  left: DirectoryToken,
  right: DirectoryToken,
): boolean => {
  if (left.kind === 'literal') {
    return tokenAcceptsLiteral(right, left.value);
  }
  if (right.kind === 'literal') {
    return tokenAcceptsLiteral(left, right.value);
  }
  return true;
};

const nextIndex = (token: DirectoryToken, index: number): number =>
  token.kind === 'wildcard' ? index : index + 1;

type DirectoryState = readonly [number, number];

type DirectoryTransition = {
  readonly left: ReadonlyArray<DirectoryToken>;
  readonly right: ReadonlyArray<DirectoryToken>;
  readonly leftIndex: number;
  readonly rightIndex: number;
  readonly pending: Array<DirectoryState>;
};

const enqueueTransitions = ({
  left,
  right,
  leftIndex,
  rightIndex,
  pending,
}: DirectoryTransition): void => {
  const leftToken = left[leftIndex];
  const rightToken = right[rightIndex];
  if (leftToken?.kind === 'wildcard') {
    pending.push([leftIndex + 1, rightIndex]);
  }
  if (rightToken?.kind === 'wildcard') {
    pending.push([leftIndex, rightIndex + 1]);
  }
  if (
    leftToken !== undefined &&
    rightToken !== undefined &&
    tokensCanConsumeTogether(leftToken, rightToken)
  ) {
    pending.push([
      nextIndex(leftToken, leftIndex),
      nextIndex(rightToken, rightIndex),
    ]);
  }
};

export const directoriesOverlap = (
  leftDirectory: string,
  leftSupportsGlobs: boolean,
  rightDirectory: string,
  rightSupportsGlobs: boolean,
): boolean => {
  const left = tokenizeDirectory(leftDirectory, leftSupportsGlobs);
  const right = tokenizeDirectory(rightDirectory, rightSupportsGlobs);
  const pending: Array<DirectoryState> = [[0, 0]];
  const visited = new Set<string>();

  // Walk both wildcard automata together, including each wildcard's empty transition.
  for (const [leftIndex, rightIndex] of pending) {
    const key = `${leftIndex}:${rightIndex}`;
    if (!visited.has(key)) {
      visited.add(key);

      if (leftIndex === left.length && rightIndex === right.length) {
        return true;
      }
      enqueueTransitions({
        left,
        right,
        leftIndex,
        rightIndex,
        pending,
      });
    }
  }

  return false;
};
