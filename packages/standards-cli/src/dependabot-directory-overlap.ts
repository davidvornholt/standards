import {
  type CharacterMatcher,
  matchersIntersect,
  parseCharacterClass,
} from './dependabot-directory-character-class';

type Edge = {
  readonly from: number;
  readonly to: number;
  readonly matcher: CharacterMatcher | null;
};

type Automaton = {
  readonly accept: number;
  readonly edges: ReadonlyArray<Edge>;
};

const compileDirectory = (
  directory: string,
  supportsGlobs: boolean,
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Ruby glob tokens have distinct NFA transitions that are clearest in one ordered parser.
): Automaton => {
  const characters = [...directory];
  const edges: Array<Edge> = [];
  let current = 0;
  let states = 1;
  const append = (matcher: CharacterMatcher): void => {
    const next = states;
    states += 1;
    edges.push({ from: current, to: next, matcher });
    current = next;
  };

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (!supportsGlobs) {
      append({ kind: 'literal', value: character?.codePointAt(0) ?? 0 });
    } else if (character === '\\' && characters[index + 1] !== undefined) {
      index += 1;
      append({
        kind: 'literal',
        value: characters[index]?.codePointAt(0) ?? 0,
      });
    } else if (
      character === '*' &&
      characters[index + 1] === '*' &&
      characters[index + 2] === '/' &&
      (index === 0 || characters[index - 1] === '/')
    ) {
      const next = states;
      const insideDirectory = states + 1;
      states += 2;
      edges.push(
        { from: current, to: next, matcher: null },
        { from: current, to: insideDirectory, matcher: { kind: 'non-slash' } },
        {
          from: insideDirectory,
          to: insideDirectory,
          matcher: { kind: 'non-slash' },
        },
        {
          from: insideDirectory,
          to: current,
          matcher: { kind: 'literal', value: '/'.codePointAt(0) ?? 0 },
        },
      );
      current = next;
      index += 2;
    } else if (character === '*') {
      while (characters[index + 1] === '*') {
        index += 1;
      }
      const next = states;
      states += 1;
      edges.push(
        { from: current, to: next, matcher: null },
        { from: current, to: current, matcher: { kind: 'non-slash' } },
      );
      current = next;
    } else if (character === '?') {
      append({ kind: 'non-slash' });
    } else if (character === '[') {
      const parsed = parseCharacterClass(characters, index);
      if (parsed === null) {
        append({ kind: 'literal', value: '['.codePointAt(0) ?? 0 });
      } else {
        append(parsed.matcher);
        index = parsed.end;
      }
    } else {
      append({ kind: 'literal', value: character?.codePointAt(0) ?? 0 });
    }
  }
  return { accept: current, edges };
};

export const directoriesOverlap = (
  leftDirectory: string,
  leftSupportsGlobs: boolean,
  rightDirectory: string,
  rightSupportsGlobs: boolean,
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The product walk must process both automata's epsilon and consuming transitions together.
): boolean => {
  const left = compileDirectory(leftDirectory, leftSupportsGlobs);
  const right = compileDirectory(rightDirectory, rightSupportsGlobs);
  const pending: Array<readonly [number, number]> = [[0, 0]];
  const visited = new Set<string>();
  for (const [leftState, rightState] of pending) {
    const key = `${leftState}:${rightState}`;
    if (!visited.has(key)) {
      visited.add(key);
      if (leftState === left.accept && rightState === right.accept) {
        return true;
      }
      const leftEdges = left.edges.filter((edge) => edge.from === leftState);
      const rightEdges = right.edges.filter((edge) => edge.from === rightState);
      pending.push(
        ...leftEdges
          .filter((edge) => edge.matcher === null)
          .map((edge) => [edge.to, rightState] as const),
        ...rightEdges
          .filter((edge) => edge.matcher === null)
          .map((edge) => [leftState, edge.to] as const),
      );
      for (const leftEdge of leftEdges) {
        for (const rightEdge of rightEdges) {
          if (
            leftEdge.matcher !== null &&
            rightEdge.matcher !== null &&
            matchersIntersect(leftEdge.matcher, rightEdge.matcher)
          ) {
            pending.push([leftEdge.to, rightEdge.to]);
          }
        }
      }
    }
  }
  return false;
};
