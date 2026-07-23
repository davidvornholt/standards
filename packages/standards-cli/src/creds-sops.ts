// SOPS reads inspect only plaintext key structure. Writes use a non-
// interactive editor so values never touch argv, stdout, or an unencrypted
// file outside SOPS's own temporary-file handling.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseSopsKeyPath } from './creds-dest';
import {
  type SopsValueChange as EditorValueChange,
  inspectSopsStructure,
  SET_CHANGES_ENV,
  type SopsShapeFailure,
  type SopsStructureResult,
} from './creds-sops-editor';
import { isRecord } from './github-settings-parse';
import { runSops } from './sops-exec';

export type { SopsValueChange } from './creds-sops-editor';

const SOPS_UNCHANGED_STATUS = 200;
type ReadFailure =
  | SopsShapeFailure
  | {
      readonly ok: false;
      readonly kind: 'read-error';
      readonly problem: string;
    };
export type EncryptedKeysReadResult =
  | { readonly ok: true; readonly keys: ReadonlyArray<string> }
  | ReadFailure;
export type SopsScalarDestinationResult =
  | { readonly ok: true; readonly state: 'absent' | 'scalar' }
  | ReadFailure
  | {
      readonly ok: false;
      readonly kind: 'collection' | 'blocked-by-scalar';
      readonly problem: string;
    };
export type SopsWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: string };

export const listEncryptedKeys = (text: string): EncryptedKeysReadResult => {
  const result = inspectSopsStructure(text, true);
  return result.ok ? { ok: true, keys: result.keys } : result;
};

export const readEncryptedKeys = async (
  consumer: string,
  rel: string,
): Promise<EncryptedKeysReadResult> => {
  try {
    return listEncryptedKeys(await readFile(join(consumer, rel), 'utf8'));
  } catch {
    return {
      ok: false,
      kind: 'read-error',
      problem: `could not read encrypted secrets target ${rel}`,
    };
  }
};

const inspectScalar = (
  structure: SopsStructureResult,
  dottedPath: string,
): SopsScalarDestinationResult => {
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

export const inspectSopsScalarDestination = async (
  consumer: string,
  rel: string,
  dottedPath: string,
): Promise<SopsScalarDestinationResult> => {
  try {
    const text = await readFile(join(consumer, rel), 'utf8');
    return inspectScalar(inspectSopsStructure(text, true), dottedPath);
  } catch {
    return {
      ok: false,
      kind: 'read-error',
      problem: `could not read encrypted secrets target ${rel}`,
    };
  }
};

export const verifySopsScalarLeaf = async (
  consumer: string,
  rel: string,
  dottedPath: string,
): Promise<SopsWriteResult> => {
  const result = await inspectSopsScalarDestination(consumer, rel, dottedPath);
  return result.ok && result.state === 'scalar'
    ? { ok: true }
    : {
        ok: false,
        problem: result.ok
          ? `SOPS write did not create ${dottedPath} in ${rel}`
          : result.problem,
      };
};

const editorCommand = (): string => {
  const editor = fileURLToPath(
    new URL('./creds-sops-editor.ts', import.meta.url),
  );
  return `"${process.execPath}" "${editor}"`;
};

export const setSopsValues = (
  consumer: string,
  rel: string,
  changes: ReadonlyArray<EditorValueChange>,
): SopsWriteResult => {
  const result = runSops(['edit', rel], consumer, {
    // biome-ignore lint/style/useNamingConvention: sops defines this environment variable.
    SOPS_EDITOR: editorCommand(),
    [SET_CHANGES_ENV]: JSON.stringify(changes),
  });
  if (result.status === 0 || result.status === SOPS_UNCHANGED_STATUS) {
    return { ok: true };
  }
  const paths = changes.map(({ path }) => path).join(', ');
  const detail = result.errorMessage ?? result.stderr.trim();
  return {
    ok: false,
    problem: `could not write ${paths} into ${rel}${detail ? `: ${detail}` : ''}`,
  };
};

export const setSopsValue = (
  consumer: string,
  rel: string,
  path: string,
  value: string,
): SopsWriteResult => setSopsValues(consumer, rel, [{ path, value }]);
