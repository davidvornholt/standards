import { LanguageVariant, SyntaxKind } from 'typescript/unstable/ast';
import { createScanner } from 'typescript/unstable/ast/scanner';

const REQUIRE_RESOLVE_OPEN_OFFSET = 3;

type ScannedToken = { readonly kind: SyntaxKind; readonly value: string };
type ModuleReference = {
  readonly specifier: string | null;
  readonly unsupported: string | null;
};

export type ModuleSyntax = {
  readonly specifiers: ReadonlyArray<string>;
  readonly unsupported: ReadonlyArray<string>;
};

const SHEBANG = /^#![^\n]*(?:\n|$)/u;

const loaderReference = (
  tokens: ReadonlyArray<ScannedToken>,
  index: number,
): ModuleReference | null => {
  const token = tokens[index] as ScannedToken;
  const [next, second, third] = tokens.slice(index + 1);
  const direct =
    (token.kind === SyntaxKind.ImportKeyword ||
      token.kind === SyntaxKind.RequireKeyword) &&
    next?.kind === SyntaxKind.OpenParenToken;
  const resolve =
    token.kind === SyntaxKind.RequireKeyword &&
    next?.kind === SyntaxKind.DotToken &&
    second?.value === 'resolve' &&
    third?.kind === SyntaxKind.OpenParenToken;
  if (!(direct || resolve)) {
    return token.kind === SyntaxKind.RequireKeyword
      ? { specifier: null, unsupported: 'require' }
      : null;
  }
  const open = direct ? index + 1 : index + REQUIRE_RESOLVE_OPEN_OFFSET;
  const argument = tokens[open + 1];
  const afterArgument = tokens[open + 2];
  const literal =
    argument?.kind === SyntaxKind.StringLiteral &&
    (afterArgument?.kind === SyntaxKind.CloseParenToken ||
      afterArgument?.kind === SyntaxKind.CommaToken);
  const name = resolve ? 'require.resolve' : token.value;
  return literal
    ? { specifier: argument.value, unsupported: null }
    : { specifier: null, unsupported: name };
};

const declarationReference = (
  tokens: ReadonlyArray<ScannedToken>,
  index: number,
): ModuleReference => {
  const token = tokens[index] as ScannedToken;
  const next = tokens[index + 1];
  if (
    token.kind === SyntaxKind.ImportKeyword &&
    next?.kind === SyntaxKind.StringLiteral
  ) {
    return { specifier: next.value, unsupported: null };
  }
  const isStatic =
    token.kind === SyntaxKind.ImportKeyword ||
    token.kind === SyntaxKind.ExportKeyword;
  const end = tokens.findIndex(
    ({ kind }, candidate) =>
      candidate > index && kind === SyntaxKind.SemicolonToken,
  );
  const statement = isStatic
    ? tokens.slice(index, end < 0 ? undefined : end)
    : [];
  const from = statement.findIndex(
    ({ kind }) => kind === SyntaxKind.FromKeyword,
  );
  const specifier = from >= 0 ? statement[from + 1] : undefined;
  return specifier?.kind === SyntaxKind.StringLiteral
    ? { specifier: specifier.value, unsupported: null }
    : { specifier: null, unsupported: null };
};

const moduleReference = (
  tokens: ReadonlyArray<ScannedToken>,
  index: number,
): ModuleReference =>
  loaderReference(tokens, index) ?? declarationReference(tokens, index);

export const moduleSyntax = (source: string): ModuleSyntax => {
  const scanner = createScanner(
    true,
    LanguageVariant.Standard,
    source.replace(SHEBANG, ''),
  );
  const tokens: Array<ScannedToken> = [];
  for (
    let kind = scanner.scan();
    kind !== SyntaxKind.EndOfFile;
    kind = scanner.scan()
  ) {
    tokens.push({ kind, value: scanner.getTokenValue() });
  }
  const references = tokens.map((_token, index) =>
    moduleReference(tokens, index),
  );
  return {
    specifiers: [
      ...new Set(references.flatMap(({ specifier }) => specifier ?? [])),
    ],
    unsupported: references.flatMap(({ unsupported }) => unsupported ?? []),
  };
};
