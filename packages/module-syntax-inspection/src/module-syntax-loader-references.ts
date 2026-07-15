import type { Node, TraversalAncestors } from '@babel/types';
import {
  isAssignmentExpression,
  isCallExpression,
  isIdentifier,
  isImportDeclaration,
  isImportSpecifier,
  isMemberExpression,
  isObjectExpression,
  isObjectPattern,
  isObjectProperty,
  isOptionalCallExpression,
  isStringLiteral,
  isVariableDeclarator,
  traverse,
} from '@babel/types';
import { isRequireMember, memberName } from './module-syntax-values';

type UnsupportedLoaderProblem =
  | 'getBuiltinModule uses unsupported loader syntax'
  | 'require uses unsupported loader syntax';

export type LoaderReferenceContext = {
  readonly getBuiltinBindings: ReadonlySet<string>;
  readonly safeObjectBindings: ReadonlySet<string>;
};

const importSource = (ancestors: TraversalAncestors): string | null => {
  const declaration = ancestors.at(-1)?.node;
  return isImportDeclaration(declaration) ? declaration.source.value : null;
};

export const loaderReferenceContext = (ast: Node): LoaderReferenceContext => {
  const getBuiltinBindings = new Set<string>();
  const safeObjectBindings = new Set<string>();
  traverse(ast, (node, ancestors) => {
    if (
      importSource(ancestors) === 'node:process' &&
      isImportSpecifier(node) &&
      (isIdentifier(node.imported, { name: 'getBuiltinModule' }) ||
        (isStringLiteral(node.imported) &&
          node.imported.value === 'getBuiltinModule'))
    ) {
      getBuiltinBindings.add(node.local.name);
    }
    if (
      isVariableDeclarator(node) &&
      isIdentifier(node.id) &&
      isSafeObjectSource(node.init)
    ) {
      safeObjectBindings.add(node.id.name);
    }
  });
  return { getBuiltinBindings, safeObjectBindings };
};

const isDirectCallCallee = (node: Node, parent: Node | undefined): boolean =>
  (isCallExpression(parent) || isOptionalCallExpression(parent)) &&
  parent.callee === node;

const isSupportedRequireReference = (
  node: Node,
  ancestors: TraversalAncestors,
): boolean => {
  const parent = ancestors.at(-1)?.node;
  const grandparent = ancestors.at(-2)?.node;
  if (isDirectCallCallee(node, parent)) {
    return true;
  }
  return (
    isMemberExpression(parent) &&
    parent.object === node &&
    memberName(parent) === 'resolve' &&
    isDirectCallCallee(parent, grandparent)
  );
};

const destructureSource = (
  node: Node,
  ancestors: TraversalAncestors,
): Node | null => {
  const pattern = ancestors.at(-1)?.node;
  const owner = ancestors.at(-2)?.node;
  if (!(isObjectProperty(node) && isObjectPattern(pattern))) {
    return null;
  }
  if (isVariableDeclarator(owner) && owner.id === pattern) {
    return owner.init ?? null;
  }
  return isAssignmentExpression(owner) && owner.left === pattern
    ? owner.right
    : null;
};

const loaderPropertyName = (node: Node): string | null => {
  if (!isObjectProperty(node)) {
    return null;
  }
  if (isIdentifier(node.key)) {
    return node.key.name;
  }
  return isStringLiteral(node.key) ? node.key.value : null;
};

const isSafeObjectSource = (node: Node | null | undefined): boolean =>
  isObjectExpression(node) &&
  node.properties.every(
    (property) =>
      isObjectProperty(property) &&
      (loaderPropertyName(property) === null ||
        !['getBuiltinModule', 'require'].includes(
          loaderPropertyName(property) ?? '',
        ) ||
        isStringLiteral(property.value)),
  );

const isSafeObjectReceiver = (
  node: Node,
  context: LoaderReferenceContext,
): boolean =>
  isSafeObjectSource(node) ||
  (isIdentifier(node) && context.safeObjectBindings.has(node.name));

const isGetBuiltinReference = (
  node: Node,
  ancestors: TraversalAncestors,
  context: LoaderReferenceContext,
): boolean => {
  if (
    isMemberExpression(node) &&
    memberName(node) === 'getBuiltinModule' &&
    !isSafeObjectReceiver(node.object, context)
  ) {
    return true;
  }
  if (
    isIdentifier(node) &&
    context.getBuiltinBindings.has(node.name) &&
    !isImportSpecifier(ancestors.at(-1)?.node)
  ) {
    return true;
  }
  const source = destructureSource(node, ancestors);
  return (
    loaderPropertyName(node) === 'getBuiltinModule' &&
    source !== null &&
    !isSafeObjectReceiver(source, context)
  );
};

const isUnsupportedRequireMember = (
  node: Node,
  ancestors: TraversalAncestors,
  context: LoaderReferenceContext,
): boolean => {
  const parent = ancestors.at(-1)?.node;
  if (isMemberExpression(node) && memberName(node) === 'require') {
    if (isSafeObjectReceiver(node.object, context)) {
      return false;
    }
    return !(isRequireMember(node) && isDirectCallCallee(node, parent));
  }
  const source = destructureSource(node, ancestors);
  return (
    loaderPropertyName(node) === 'require' &&
    source !== null &&
    !isSafeObjectReceiver(source, context)
  );
};

export const unsupportedLoaderReference = (
  node: Node,
  ancestors: TraversalAncestors,
  context: LoaderReferenceContext,
): UnsupportedLoaderProblem | null => {
  if (isGetBuiltinReference(node, ancestors, context)) {
    return 'getBuiltinModule uses unsupported loader syntax';
  }
  if (isUnsupportedRequireMember(node, ancestors, context)) {
    return 'require uses unsupported loader syntax';
  }
  const parent = ancestors.at(-1)?.node;
  if (
    isIdentifier(node, { name: 'require' }) &&
    !isSupportedRequireReference(node, ancestors) &&
    !(
      (isMemberExpression(parent) && parent.property === node) ||
      (isObjectProperty(parent) && parent.key === node && !parent.shorthand)
    )
  ) {
    return 'require uses unsupported loader syntax';
  }
  return null;
};
