import type { CallExpression, Node } from '@babel/types';
import {
  isArrayExpression,
  isCallExpression,
  isIdentifier,
  isMemberExpression,
  isStringLiteral,
  isTemplateLiteral,
} from '@babel/types';

type Loader = {
  readonly argument: Node | undefined;
  readonly name: string;
};

export const memberName = (node: Node): string | null => {
  if (!isMemberExpression(node)) {
    return null;
  }
  if (isIdentifier(node.property)) {
    return node.property.name;
  }
  return isStringLiteral(node.property) ? node.property.value : null;
};

const joinedStringValue = (node: Node): string | null => {
  if (
    !(isCallExpression(node) && isMemberExpression(node.callee)) ||
    memberName(node.callee) !== 'join' ||
    !isArrayExpression(node.callee.object) ||
    node.arguments.length !== 1 ||
    !isStringLiteral(node.arguments[0])
  ) {
    return null;
  }
  const parts = node.callee.object.elements;
  if (parts.some((part) => !isStringLiteral(part))) {
    return null;
  }
  return parts
    .map((part) => (isStringLiteral(part) ? part.value : ''))
    .join(node.arguments[0].value);
};

export const staticStringValue = (node: Node | undefined): string | null => {
  if (isStringLiteral(node)) {
    return node.value;
  }
  if (isTemplateLiteral(node) && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw ?? null;
  }
  return node === undefined ? null : joinedStringValue(node);
};

const isGlobalThisModule = (node: Node): boolean =>
  isMemberExpression(node) &&
  isIdentifier(node.object, { name: 'globalThis' }) &&
  memberName(node) === 'module';

export const isRequireMember = (node: Node): boolean =>
  isMemberExpression(node) &&
  memberName(node) === 'require' &&
  (isIdentifier(node.object, { name: 'globalThis' }) ||
    isIdentifier(node.object, { name: 'module' }) ||
    isGlobalThisModule(node.object));

export const loaderForCall = (node: CallExpression): Loader | null => {
  if (isIdentifier(node.callee, { name: 'require' })) {
    return { argument: node.arguments[0], name: 'require' };
  }
  if (!isMemberExpression(node.callee)) {
    return null;
  }
  const name = memberName(node.callee);
  if (
    name === 'resolve' &&
    isIdentifier(node.callee.object, { name: 'require' })
  ) {
    return { argument: node.arguments[0], name: 'require.resolve' };
  }
  if (name === 'require' && isRequireMember(node.callee)) {
    return { argument: node.arguments[0], name: 'require' };
  }
  return null;
};
