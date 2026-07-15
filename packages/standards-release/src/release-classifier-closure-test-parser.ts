import { LanguageVariant, SyntaxKind } from 'typescript/unstable/ast';
import { createScanner } from 'typescript/unstable/ast/scanner';

type Token = {
  readonly kind: SyntaxKind;
  readonly text: string;
  readonly value: string;
};

export type ClassifierSourceInspection = {
  readonly problems: ReadonlyArray<string>;
  readonly specifiers: ReadonlyArray<string>;
};

const JOIN_SUFFIX_LENGTH = 5;

const tokensOf = (source: string): ReadonlyArray<Token> => {
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  const tokens: Array<Token> = [];
  let kind = scanner.scan();
  while (kind !== SyntaxKind.EndOfFile) {
    tokens.push({
      kind,
      text: scanner.getTokenText(),
      value: scanner.getTokenValue(),
    });
    kind = scanner.scan();
  }
  return tokens;
};

const stringValue = (token: Token | undefined): string | null =>
  token?.kind === SyntaxKind.StringLiteral ||
  token?.kind === SyntaxKind.NoSubstitutionTemplateLiteral
    ? token.value
    : null;

const callArguments = (
  tokens: ReadonlyArray<Token>,
  open: number,
): { readonly close: number; readonly tokens: ReadonlyArray<Token> } | null => {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    if (tokens[index]?.kind === SyntaxKind.OpenParenToken) {
      depth += 1;
    } else if (tokens[index]?.kind === SyntaxKind.CloseParenToken) {
      depth -= 1;
      if (depth === 0) {
        return { close: index, tokens: tokens.slice(open + 1, index) };
      }
    }
  }
  return null;
};

const staticSpecifier = (tokens: ReadonlyArray<Token>): string | null => {
  const first = stringValue(tokens[0]);
  if (
    first !== null &&
    (tokens.length === 1 || tokens[1]?.kind === SyntaxKind.CommaToken)
  ) {
    return first;
  }
  const bracket = tokens.length - JOIN_SUFFIX_LENGTH - 1;
  const [dot, join, open, separatorToken, close] = tokens.slice(bracket + 1);
  if (
    tokens[0]?.kind !== SyntaxKind.OpenBracketToken ||
    tokens[bracket]?.kind !== SyntaxKind.CloseBracketToken ||
    dot?.kind !== SyntaxKind.DotToken ||
    join?.value !== 'join' ||
    open?.kind !== SyntaxKind.OpenParenToken ||
    close?.kind !== SyntaxKind.CloseParenToken
  ) {
    return null;
  }
  const separator = stringValue(separatorToken);
  const parts = tokens.slice(1, bracket);
  if (
    separator === null ||
    parts.length % 2 === 0 ||
    parts.some((token, index) =>
      index % 2 === 0
        ? stringValue(token) === null
        : token.kind !== SyntaxKind.CommaToken,
    )
  ) {
    return null;
  }
  return parts
    .filter((_, index) => index % 2 === 0)
    .map((token) => stringValue(token) ?? '')
    .join(separator);
};

const declarationSpecifier = (
  tokens: ReadonlyArray<Token>,
  start: number,
): string | null => {
  if (
    tokens[start]?.kind === SyntaxKind.ImportKeyword &&
    stringValue(tokens[start + 1]) !== null
  ) {
    return stringValue(tokens[start + 1]);
  }
  for (let index = start + 1; index < tokens.length; index += 1) {
    if (tokens[index]?.kind === SyntaxKind.FromKeyword) {
      return stringValue(tokens[index + 1]);
    }
    if (tokens[index]?.kind === SyntaxKind.SemicolonToken) {
      return null;
    }
  }
  return null;
};

const appendDeclarationSpecifier = (
  tokens: ReadonlyArray<Token>,
  index: number,
  specifiers: Array<string>,
): void => {
  const specifier = declarationSpecifier(tokens, index);
  if (specifier !== null) {
    specifiers.push(specifier);
  }
};

const loaderCall = (
  tokens: ReadonlyArray<Token>,
  index: number,
): { readonly name: string; readonly open: number } | null => {
  const token = tokens[index];
  if (
    token?.kind === SyntaxKind.ImportKeyword &&
    tokens[index + 1]?.kind === SyntaxKind.OpenParenToken
  ) {
    return { name: 'import', open: index + 1 };
  }
  if (token?.kind !== SyntaxKind.RequireKeyword) {
    return null;
  }
  if (tokens[index + 1]?.kind === SyntaxKind.OpenParenToken) {
    return { name: 'require', open: index + 1 };
  }
  const [dot, resolve, open] = tokens.slice(index + 1);
  return dot?.kind === SyntaxKind.DotToken &&
    resolve?.value === 'resolve' &&
    open?.kind === SyntaxKind.OpenParenToken
    ? { name: 'require.resolve', open: tokens.indexOf(open, index) }
    : null;
};

// Type-only edges count: the exception bans third-party imports across the
// complete source closure even though Bun erases them before execution.
export const inspectClassifierSource = (
  source: string,
): ClassifierSourceInspection => {
  const specifiers: Array<string> = [];
  const problems: Array<string> = [];
  const tokens = tokensOf(source);
  for (let index = 0; index < tokens.length; index += 1) {
    const call = loaderCall(tokens, index);
    if (call !== null) {
      const args = callArguments(tokens, call.open);
      const specifier = args === null ? null : staticSpecifier(args.tokens);
      if (specifier === null) {
        problems.push(`${call.name} requires a statically known specifier`);
      } else {
        specifiers.push(specifier);
      }
      if (args !== null) {
        index = args.close;
      }
    } else if (
      tokens[index]?.kind === SyntaxKind.ImportKeyword ||
      tokens[index]?.kind === SyntaxKind.ExportKeyword
    ) {
      appendDeclarationSpecifier(tokens, index, specifiers);
    } else if (tokens[index]?.kind === SyntaxKind.RequireKeyword) {
      problems.push('require uses unsupported syntax');
    }
  }
  return {
    problems,
    specifiers: specifiers.filter(
      (specifier, index) => specifiers.indexOf(specifier) === index,
    ),
  };
};
