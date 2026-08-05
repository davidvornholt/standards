// SOPS reads inspect only plaintext key structure. Writes use a non-
// interactive editor so values never touch argv, stdout, or an unencrypted
// file outside SOPS's own temporary-file handling.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isContainedPath } from './contained-path';
import {
  type SopsValueChange as EditorValueChange,
  inspectSopsScalarStructure,
  SET_CHANGES_ENV,
  type SopsScalarStructureResult,
} from './creds-sops-editor';
import {
  inspectSopsStructure,
  type SopsShapeFailure,
} from './creds-sops-structure';
import { runSops } from './sops-exec';

export type { SopsValueChange } from './creds-sops-editor';

const SOPS_UNCHANGED_STATUS = 200;
type ReadError = {
  readonly ok: false;
  readonly kind: 'read-error';
  readonly problem: string;
};
type ReadFailure = SopsShapeFailure | ReadError;
export type EncryptedKeysReadResult =
  | { readonly ok: true; readonly keys: ReadonlyArray<string> }
  | ReadFailure;
export type SopsScalarDestinationResult = SopsScalarStructureResult | ReadError;
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
  if (!isContainedPath(consumer, rel, 'file')) {
    return {
      ok: false,
      kind: 'read-error',
      problem: `unsafe encrypted secrets target ${rel}`,
    };
  }
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

export const inspectSopsScalarDestination = async (
  consumer: string,
  rel: string,
  dottedPath: string,
): Promise<SopsScalarDestinationResult> => {
  if (!isContainedPath(consumer, rel, 'file')) {
    return {
      ok: false,
      kind: 'read-error',
      problem: `unsafe encrypted secrets target ${rel}`,
    };
  }
  try {
    const text = await readFile(join(consumer, rel), 'utf8');
    return inspectSopsScalarStructure(
      inspectSopsStructure(text, true),
      dottedPath,
    );
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
  if (!isContainedPath(consumer, rel, 'file')) {
    return { ok: false, problem: `unsafe encrypted secrets target ${rel}` };
  }
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
