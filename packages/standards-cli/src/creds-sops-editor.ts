import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { parseDocument } from 'yaml';
import { assertWritableSopsPath } from './creds-dest';
import {
  inspectSopsStructure,
  parseSopsKeyPath,
  type SopsShapeFailure,
  type SopsStructureResult,
} from './creds-sops-structure';
import { isRecord } from './github-settings-parse';

export const SET_CHANGES_ENV = 'STANDARDS_SOPS_SET_CHANGES';
export type SopsValueChange = {
  readonly path: string;
  readonly value: string;
};
export type SopsScalarStructureResult =
  | { readonly ok: true; readonly state: 'absent' | 'scalar' }
  | SopsShapeFailure
  | {
      readonly ok: false;
      readonly kind: 'collection' | 'blocked-by-scalar';
      readonly problem: string;
    };

export const inspectSopsScalarStructure = (
  structure: SopsStructureResult,
  dottedPath: string,
): SopsScalarStructureResult => {
  if (!structure.ok) {
    return structure;
  }
  const path = parseSopsKeyPath(dottedPath);
  if (path === null) {
    return {
      ok: false,
      kind: 'unsupported-shape',
      problem: `invalid SOPS key path: ${dottedPath}`,
    };
  }
  let node: unknown = structure.root;
  for (const [index, segment] of path.entries()) {
    if (!isRecord(node)) {
      return {
        ok: false,
        kind: 'blocked-by-scalar',
        problem: `SOPS key path is blocked by a scalar: ${dottedPath}`,
      };
    }
    const next = node[segment];
    if (next === undefined) {
      return { ok: true, state: 'absent' };
    }
    if (index === path.length - 1) {
      return isRecord(next)
        ? {
            ok: false,
            kind: 'collection',
            problem: `SOPS key path names a mapping: ${dottedPath}`,
          }
        : { ok: true, state: 'scalar' };
    }
    node = next;
  }
  return { ok: true, state: 'absent' };
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
