import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type YAMLMap,
} from 'yaml';
import { isRecord } from './github-settings-parse';

const SAFE_KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const RESERVED_KEY_SEGMENTS = new Set([
  'constructor',
  'prototype',
  'sops',
  '__proto__',
]);
export type SopsShapeFailure = {
  readonly ok: false;
  readonly kind:
    | 'malformed-yaml'
    | 'missing-sops-metadata'
    | 'unsupported-shape';
  readonly problem: string;
};
export type SopsStructureResult =
  | {
      readonly ok: true;
      readonly keys: ReadonlyArray<string>;
      readonly root: Readonly<Record<string, unknown>>;
    }
  | SopsShapeFailure;
export const isSafeSopsKeySegment = (segment: string): boolean =>
  SAFE_KEY_SEGMENT.test(segment) && !RESERVED_KEY_SEGMENTS.has(segment);
export const parseSopsKeyPath = (
  dottedPath: string,
): ReadonlyArray<string> | null => {
  const segments = dottedPath.split('.');
  return segments.length > 0 && segments.every(isSafeSopsKeySegment)
    ? segments
    : null;
};
const isContained = (root: string, candidate: string): boolean => {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== '' &&
    !isAbsolute(fromRoot) &&
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`)
  );
};
const matchesKind = (stat: Stats, kind: 'directory' | 'file'): boolean =>
  kind === 'file' ? stat.isFile() : stat.isDirectory();
export const isContainedSopsPath = (
  consumer: string,
  rel: string,
  kind: 'directory' | 'file',
): boolean => {
  try {
    if (
      isAbsolute(rel) ||
      rel.includes('\\') ||
      lstatSync(consumer).isSymbolicLink()
    ) {
      return false;
    }
    const parts = rel.split('/');
    if (
      parts.length === 0 ||
      parts.some((part) => ['', '.', '..'].includes(part))
    ) {
      return false;
    }
    const root = realpathSync(consumer);
    let candidate = consumer;
    for (const [index, part] of parts.entries()) {
      candidate = join(candidate, part);
      const stat = lstatSync(candidate);
      const final = index === parts.length - 1;
      const expectedKind = final ? kind : 'directory';
      if (
        stat.isSymbolicLink() ||
        !isContained(root, realpathSync(candidate)) ||
        !matchesKind(stat, expectedKind)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
};
const keyName = (node: unknown): string | null =>
  isScalar(node) && typeof node.value === 'string' && node.tag === undefined
    ? node.value
    : null;

const collectLeaves = (
  node: unknown,
  prefix: ReadonlyArray<string>,
  keys: Array<string>,
): string | null => {
  if (isSeq(node)) {
    return `arrays are not supported at ${prefix.join('.')}`;
  }
  if (isAlias(node)) {
    return `aliases are not supported at ${prefix.join('.')}`;
  }
  if (!isMap(node)) {
    keys.push(prefix.join('.'));
    return null;
  }
  for (const pair of node.items) {
    const key = keyName(pair.key);
    if (key === null || !isSafeSopsKeySegment(key)) {
      return `unsupported mapping key at ${prefix.join('.')}`;
    }
    const problem = collectLeaves(pair.value, [...prefix, key], keys);
    if (problem !== null) {
      return problem;
    }
  }
  return null;
};
type RootInspection = {
  readonly keys: ReadonlyArray<string>;
  readonly hasMetadata: boolean;
  readonly problem: string | null;
};
const inspectRoot = (root: YAMLMap): RootInspection => {
  const keys: Array<string> = [];
  let hasMetadata = false;
  for (const pair of root.items) {
    const key = keyName(pair.key);
    if (key === null || (!isSafeSopsKeySegment(key) && key !== 'sops')) {
      return {
        keys,
        hasMetadata,
        problem: 'secrets document has an unsupported mapping key',
      };
    }
    if (key === 'sops') {
      hasMetadata = isMap(pair.value);
    } else {
      const problem = collectLeaves(pair.value, [key], keys);
      if (problem !== null) {
        return { keys, hasMetadata, problem };
      }
    }
  }
  return { keys, hasMetadata, problem: null };
};

export const inspectSopsStructure = (
  text: string,
  requireMetadata: boolean,
): SopsStructureResult => {
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    return {
      ok: false,
      kind: 'malformed-yaml',
      problem: 'secrets document is malformed YAML',
    };
  }
  if (!isMap(document.contents)) {
    return {
      ok: false,
      kind: 'unsupported-shape',
      problem: 'secrets document root must be a mapping',
    };
  }
  const inspected = inspectRoot(document.contents);
  if (inspected.problem !== null) {
    return {
      ok: false,
      kind: 'unsupported-shape',
      problem: inspected.problem,
    };
  }
  if (requireMetadata && !inspected.hasMetadata) {
    return {
      ok: false,
      kind: 'missing-sops-metadata',
      problem: 'secrets document has no SOPS metadata',
    };
  }
  const root = document.toJS();
  return isRecord(root)
    ? { ok: true, keys: inspected.keys, root }
    : {
        ok: false,
        kind: 'unsupported-shape',
        problem: 'secrets document root must be a mapping',
      };
};
