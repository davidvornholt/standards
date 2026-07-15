import { parse } from '@babel/parser';
import type { CallExpression, Node, TraversalAncestors } from '@babel/types';
import {
  isCallExpression,
  isExportAllDeclaration,
  isExportNamedDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportExpression,
  isMemberExpression,
  isOptionalCallExpression,
  isTSExternalModuleReference,
  isTSImportType,
  traverse,
} from '@babel/types';
import {
  loaderReferenceContext,
  unsupportedLoaderReference,
} from './module-syntax-loader-references';
import {
  isRequireMember,
  loaderForCall,
  memberName,
  staticStringValue,
} from './module-syntax-values';

export type ModuleSyntaxInspection = {
  readonly problems: ReadonlyArray<string>;
  readonly specifiers: ReadonlyArray<string>;
};

type InspectionState = {
  readonly context: ReturnType<typeof loaderReferenceContext>;
  readonly problems: Array<string>;
  readonly specifiers: Array<string>;
};

const inspectCall = (
  node: CallExpression,
  specifiers: Array<string>,
  problems: Array<string>,
): void => {
  const loader = loaderForCall(node);
  if (loader === null) {
    return;
  }
  const specifier = staticStringValue(loader.argument);
  if (specifier === null) {
    problems.push(`${loader.name} requires a statically known specifier`);
  } else {
    specifiers.push(specifier);
  }
};

const declarationSpecifier = (node: Node): string | null => {
  if (
    isImportDeclaration(node) ||
    isExportNamedDeclaration(node) ||
    isExportAllDeclaration(node)
  ) {
    return staticStringValue(node.source ?? undefined);
  }
  if (isTSImportType(node)) {
    return node.source.value;
  }
  return isTSExternalModuleReference(node) ? node.expression.value : null;
};

const inspectImport = (
  node: Node,
  specifiers: Array<string>,
  problems: Array<string>,
): void => {
  if (!isImportExpression(node)) {
    return;
  }
  const specifier = staticStringValue(node.source);
  if (specifier === null) {
    problems.push('import requires a statically known specifier');
  } else {
    specifiers.push(specifier);
  }
};

const inspectOptionalCall = (node: Node, problems: Array<string>): void => {
  if (
    isOptionalCallExpression(node) &&
    (isIdentifier(node.callee, { name: 'require' }) ||
      (isMemberExpression(node.callee) &&
        (isRequireMember(node.callee) ||
          (memberName(node.callee) === 'resolve' &&
            isIdentifier(node.callee.object, { name: 'require' })))))
  ) {
    problems.push('require uses unsupported loader syntax');
  }
};

const inspectNode = (
  node: Node,
  ancestors: TraversalAncestors,
  state: InspectionState,
): void => {
  const unsupportedReference = unsupportedLoaderReference(
    node,
    ancestors,
    state.context,
  );
  if (unsupportedReference !== null) {
    state.problems.push(unsupportedReference);
  } else if (isImportExpression(node)) {
    inspectImport(node, state.specifiers, state.problems);
  } else if (isCallExpression(node)) {
    inspectCall(node, state.specifiers, state.problems);
  } else if (isOptionalCallExpression(node)) {
    inspectOptionalCall(node, state.problems);
  } else {
    const specifier = declarationSpecifier(node);
    if (specifier !== null) {
      state.specifiers.push(specifier);
    }
  }
};

export const inspectModuleSyntax = (source: string): ModuleSyntaxInspection => {
  const specifiers: Array<string> = [];
  const problems: Array<string> = [];
  const ast = parse(source, { plugins: ['typescript'], sourceType: 'module' });
  const state = {
    context: loaderReferenceContext(ast),
    problems,
    specifiers,
  };
  traverse(ast, (node, ancestors) => inspectNode(node, ancestors, state));
  return {
    problems: problems.filter(
      (problem, index) => problems.indexOf(problem) === index,
    ),
    specifiers: specifiers.filter(
      (specifier, index) => specifiers.indexOf(specifier) === index,
    ),
  };
};
