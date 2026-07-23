import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { parse, parseDocument } from 'yaml';
import {
  assertWritableSopsPath,
  isSafeSopsKeySegment,
  parseSopsKeyPath,
} from './creds-dest';
import { isRecord } from './github-settings-parse';

export const SET_CHANGES_ENV = 'STANDARDS_SOPS_SET_CHANGES';
export type SopsValueChange = {
  readonly path: string;
  readonly value: string;
};
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
const collectLeaves = (
  node: unknown,
  prefix: ReadonlyArray<string>,
  keys: Array<string>,
  seen: WeakSet<object>,
): string | null => {
  if (Array.isArray(node)) {
    return `arrays are not supported at ${prefix.join('.')}`;
  }
  if (!isRecord(node)) {
    keys.push(prefix.join('.'));
    return null;
  }
  if (seen.has(node)) {
    return `aliases are not supported at ${prefix.join('.')}`;
  }
  seen.add(node);
  for (const [key, value] of Object.entries(node)) {
    if (!isSafeSopsKeySegment(key)) {
      return `unsupported mapping key at ${[...prefix, key].join('.')}`;
    }
    const problem = collectLeaves(value, [...prefix, key], keys, seen);
    if (problem !== null) {
      return problem;
    }
  }
  return null;
};
export const inspectSopsStructure = (
  text: string,
  requireMetadata: boolean,
): SopsStructureResult => {
  let root: unknown;
  try {
    root = parse(text);
  } catch {
    return {
      ok: false,
      kind: 'malformed-yaml',
      problem: 'secrets document is malformed YAML',
    };
  }
  if (!isRecord(root)) {
    return {
      ok: false,
      kind: 'unsupported-shape',
      problem: 'secrets document root must be a mapping',
    };
  }
  if (requireMetadata && !isRecord(root.sops)) {
    return {
      ok: false,
      kind: 'missing-sops-metadata',
      problem: 'secrets document has no SOPS metadata',
    };
  }
  const keys: Array<string> = [];
  const seen = new WeakSet<object>();
  for (const [key, value] of Object.entries(root)) {
    if (key !== 'sops') {
      if (!isSafeSopsKeySegment(key)) {
        return {
          ok: false,
          kind: 'unsupported-shape',
          problem: `unsupported mapping key at ${key}`,
        };
      }
      const problem = collectLeaves(value, [key], keys, seen);
      if (problem !== null) {
        return { ok: false, kind: 'unsupported-shape', problem };
      }
    }
  }
  return { ok: true, keys, root };
};
const parseChanges = (raw: string): ReadonlyArray<SopsValueChange> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${SET_CHANGES_ENV} must contain valid JSON`, {
      cause: error,
    });
  }
  if (
    !(
      Array.isArray(parsed) &&
      parsed.every(
        (change) =>
          isRecord(change) &&
          typeof change.path === 'string' &&
          typeof change.value === 'string',
      )
    )
  ) {
    throw new Error(`${SET_CHANGES_ENV} must contain SOPS value changes`);
  }
  return parsed;
};
const parseDistinctPaths = (
  changes: ReadonlyArray<SopsValueChange>,
): ReadonlyArray<ReadonlyArray<string>> => {
  if (changes.length === 0) {
    throw new Error('at least one SOPS change is required');
  }
  const paths = changes.map(({ path }) => {
    const parsed = parseSopsKeyPath(path);
    if (parsed === null) {
      throw new Error(`invalid SOPS key path: ${path}`);
    }
    return parsed;
  });
  for (const [index, path] of paths.entries()) {
    for (const other of paths.slice(index + 1)) {
      const pathContainsOther = path.every(
        (segment, part) => other[part] === segment,
      );
      const otherContainsPath = other.every(
        (segment, part) => path[part] === segment,
      );
      if (pathContainsOther || otherContainsPath) {
        throw new Error(
          'SOPS changes must have distinct, non-overlapping paths',
        );
      }
    }
  }
  return paths;
};
export const applySopsEditorChanges = (
  text: string,
  changes: ReadonlyArray<SopsValueChange>,
): string => {
  const structure = inspectSopsStructure(text, false);
  if (!structure.ok) {
    throw new Error(structure.problem);
  }
  const paths = parseDistinctPaths(changes);
  for (const path of paths) {
    assertWritableSopsPath(structure.root, path);
  }
  const document = parseDocument(text);
  for (const [index, change] of changes.entries()) {
    document.setIn(paths[index] ?? [], change.value);
  }
  return document.toString();
};
const runEditor = (): void => {
  const [, , file] = process.argv;
  const changes = process.env[SET_CHANGES_ENV];
  if (file === undefined || changes === undefined) {
    console.error(`creds-sops-editor: requires a file and ${SET_CHANGES_ENV}`);
    process.exitCode = 1;
    return;
  }
  try {
    const changed = applySopsEditorChanges(
      readFileSync(file, 'utf8'),
      parseChanges(changes),
    );
    writeFileSync(file, changed);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'failure';
    console.error(`creds-sops-editor: ${message}`);
    process.exitCode = 1;
  }
};
if (import.meta.main) {
  runEditor();
}
