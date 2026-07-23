// SOPS integration for `standards creds`. Reading never decrypts: SOPS
// encrypts values but keeps the key structure plaintext, so the set of
// (target, dotted key) pairs — the repo side of the reconciliation — comes
// from parsing the encrypted YAML directly. Writing goes through `sops edit`
// with a non-interactive editor so plaintext token values never touch argv,
// stdout, or an unencrypted file outside sops's own temp handling.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { SET_PATH_ENV, SET_VALUE_ENV } from './creds-sops-editor';
import { isRecord } from './github-settings-parse';
import { runSops } from './sops-exec';

// sops exits 200 when the editor leaves the file unchanged; for a
// non-interactive value write that means the value was already set.
const SOPS_UNCHANGED_STATUS = 200;

export type SecretsTarget = { readonly target: string; readonly rel: string };

const isYamlSecrets = (name: string): boolean =>
  name.endsWith('.yaml') && !name.endsWith('.example.yaml');

const listDir = (dir: string): ReadonlyArray<string> => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

// Mirrors the canonical `just secrets` target resolution: `secrets/<t>.yaml`
// for flat targets, `infra/hosts/<t>/secrets.yaml` for host targets.
export const listSecretsTargets = (
  consumer: string,
): ReadonlyArray<SecretsTarget> => {
  const flat = listDir(join(consumer, 'secrets'))
    .filter(isYamlSecrets)
    .map((name) => ({
      target: name.slice(0, -'.yaml'.length),
      rel: `secrets/${name}`,
    }));
  const hosts = listDir(join(consumer, 'infra', 'hosts'))
    .filter((name) =>
      existsSync(join(consumer, 'infra', 'hosts', name, 'secrets.yaml')),
    )
    .map((name) => ({
      target: name,
      rel: `infra/hosts/${name}/secrets.yaml`,
    }));
  return [...flat, ...hosts].filter((entry) => {
    try {
      return statSync(join(consumer, entry.rel)).isFile();
    } catch {
      return false;
    }
  });
};

export const resolveTargetRel = (
  consumer: string,
  target: string,
): string | null => {
  const host = `infra/hosts/${target}/secrets.yaml`;
  if (existsSync(join(consumer, 'infra', 'hosts', target))) {
    return host;
  }
  const flat = `secrets/${target}.yaml`;
  return existsSync(join(consumer, flat)) ? flat : null;
};

const collectLeafPaths = (
  node: unknown,
  prefix: ReadonlyArray<string>,
  into: Array<string>,
): void => {
  if (isRecord(node)) {
    for (const [key, value] of Object.entries(node)) {
      collectLeafPaths(value, [...prefix, key], into);
    }
    return;
  }
  if (prefix.length > 0) {
    into.push(prefix.join('.'));
  }
};

// Returns the dotted leaf key paths of a SOPS-encrypted YAML document, or
// null when the file carries no sops metadata (not encrypted — never treated
// as broker-relevant).
export const listEncryptedKeys = (
  text: string,
): ReadonlyArray<string> | null => {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return null;
  }
  if (!(isRecord(parsed) && isRecord(parsed.sops))) {
    return null;
  }
  const keys: Array<string> = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== 'sops') {
      collectLeafPaths(value, [key], keys);
    }
  }
  return keys;
};

export const readEncryptedKeys = async (
  consumer: string,
  rel: string,
): Promise<ReadonlyArray<string> | null> =>
  listEncryptedKeys(await readFile(join(consumer, rel), 'utf8'));

export type SopsWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: string };

const editorCommand = (): string => {
  const editor = fileURLToPath(
    new URL('./creds-sops-editor.ts', import.meta.url),
  );
  return `"${process.execPath}" "${editor}"`;
};

export const setSopsValue = (
  consumer: string,
  rel: string,
  dottedPath: string,
  value: string,
): SopsWriteResult => {
  const result = runSops(['edit', rel], consumer, {
    // biome-ignore lint/style/useNamingConvention: sops's environment contract names the editor variable SOPS_EDITOR.
    SOPS_EDITOR: editorCommand(),
    [SET_PATH_ENV]: dottedPath,
    [SET_VALUE_ENV]: value,
  });
  if (result.status === 0 || result.status === SOPS_UNCHANGED_STATUS) {
    return { ok: true };
  }
  const detail = result.errorMessage ?? result.stderr.trim();
  return {
    ok: false,
    problem: detail
      ? `could not write ${dottedPath} into ${rel}: ${detail}`
      : `could not write ${dottedPath} into ${rel}`,
  };
};
