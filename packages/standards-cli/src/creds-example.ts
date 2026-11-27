// Keeps a secrets file's plaintext `*.example.yaml` mirroring the keys that
// `standards creds` writes, because `standards check` requires the example of
// secrets/ci.yaml to mirror every key, and SOPS encrypts comments, so the
// example is where every secret is documented. Only missing keys get a
// placeholder; existing keys, comments, and unrelated keys stay as they are.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAlias, isMap, isScalar, parseDocument, visit } from 'yaml';
import { isContainedPath } from './contained-path';
import { parseSopsKeyPath } from './creds-sops-structure';

export const exampleRelFor = (rel: string): string | null =>
  rel.endsWith('.yaml') && !rel.endsWith('.example.yaml')
    ? `${rel.slice(0, -'.yaml'.length)}.example.yaml`
    : null;

const placeholderFor = (path: ReadonlyArray<string>): string =>
  `replace-with-${(path.at(-1) ?? 'value').replaceAll('_', '-')}`;

// A path is added only where every ancestor is a mapping or missing and the
// leaf itself is missing.
const canAdd = (
  document: ReturnType<typeof parseDocument>,
  path: ReadonlyArray<string>,
): boolean => {
  for (let depth = 0; depth < path.length; depth += 1) {
    const prefix = path.slice(0, depth);
    const node =
      prefix.length === 0 ? document.contents : document.getIn(prefix, true);
    if (node === undefined || node === null) {
      return true;
    }
    if (!isMap(node)) {
      return false;
    }
  }
  return !document.hasIn(path);
};

const inheritsKeys = (document: ReturnType<typeof parseDocument>): boolean => {
  let found = false;
  visit(document, (_key, node) => {
    if (isAlias(node) || (isScalar(node) && node.value === '<<')) {
      found = true;
      return visit.BREAK;
    }
  });
  return found;
};

// Returns the updated text, or null when nothing needs adding or the example
// can't be edited safely: invalid YAML, or aliases and merge keys, where a
// new key could hide keys the example inherits.
export const addExamplePlaceholders = (
  text: string,
  dottedPaths: ReadonlyArray<string>,
): string | null => {
  const document = parseDocument(text);
  if (document.errors.length > 0 || inheritsKeys(document)) {
    return null;
  }
  const missing = dottedPaths
    .map(parseSopsKeyPath)
    .filter((path): path is ReadonlyArray<string> => path !== null)
    .filter((path) => canAdd(document, path));
  if (missing.length === 0) {
    return null;
  }
  for (const path of missing) {
    document.setIn(path, placeholderFor(path));
  }
  return document.toString();
};

// Adds placeholders to the example beside `rel` when that example exists. The
// encrypted write has already succeeded, so a failure here only warns: the
// caller still has to verify the stored value and finish its transaction.
export const mirrorExamplePlaceholders = (
  consumer: string,
  rel: string,
  dottedPaths: ReadonlyArray<string>,
): void => {
  const exampleRel = exampleRelFor(rel);
  if (exampleRel === null || !isContainedPath(consumer, exampleRel, 'file')) {
    return;
  }
  const file = join(consumer, exampleRel);
  try {
    const updated = addExamplePlaceholders(
      readFileSync(file, 'utf8'),
      dottedPaths,
    );
    if (updated !== null) {
      writeFileSync(file, updated);
    }
  } catch (error) {
    console.error(
      `standards creds: warning: could not add placeholders for ${dottedPaths.join(', ')} to ${exampleRel} (${error instanceof Error ? error.message : String(error)}); add them by hand`,
    );
  }
};
