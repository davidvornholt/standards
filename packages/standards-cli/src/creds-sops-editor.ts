// Non-interactive SOPS_EDITOR used by the creds SOPS writer: `sops edit`
// hands this script the decrypted document as a temp file, and the key path
// and value arrive via environment variables — never argv, which /proc
// exposes to every local user, and never stdout, which would land secret
// values in an agent's context. The YAML document API preserves every
// comment and the existing key order.

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { parseDocument } from 'yaml';

export const SET_PATH_ENV = 'STANDARDS_SOPS_SET_PATH';
export const SET_VALUE_ENV = 'STANDARDS_SOPS_SET_VALUE';

export const applySopsEditorChange = (
  text: string,
  dottedPath: string,
  value: string,
): string => {
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    throw new Error(
      `decrypted secrets document did not parse: ${document.errors[0]?.message}`,
    );
  }
  document.setIn(dottedPath.split('.'), value);
  return document.toString();
};

const runEditor = (): void => {
  const [, , file] = process.argv;
  const dottedPath = process.env[SET_PATH_ENV];
  const value = process.env[SET_VALUE_ENV];
  if (file === undefined || dottedPath === undefined || value === undefined) {
    console.error(
      `creds-sops-editor: requires a file argument plus ${SET_PATH_ENV} and ${SET_VALUE_ENV}`,
    );
    process.exitCode = 1;
    return;
  }
  writeFileSync(
    file,
    applySopsEditorChange(readFileSync(file, 'utf8'), dottedPath, value),
  );
};

if (import.meta.main) {
  runEditor();
}
