import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileState } from './sync-filesystem';
import { REMOVAL_BINDING_PREFIX } from './sync-transaction-namespace';
import { TRANSACTION_OWNER } from './sync-transaction-types';

const roots: Array<string> = [];

export const temporaryRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'standards-transaction-'));
  roots.push(root);
  return root;
};

export const writeFixture = (
  root: string,
  rel: string,
  contents: string,
): void => {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
};

export const readFixture = (root: string, rel: string): string =>
  readFileSync(join(root, rel), 'utf8');

export const transactionArtifacts = (root: string): ReadonlyArray<string> =>
  readdirSync(root)
    .filter(
      (name) =>
        name.startsWith('.standards-') &&
        !name.startsWith(REMOVAL_BINDING_PREFIX),
    )
    .sort();

const assertIdentityChanged = (
  before: { readonly dev: number; readonly ino: number },
  path: string,
): void => {
  const after = statSync(path);
  if (before.dev === after.dev && before.ino === after.ino) {
    throw new Error(`Fixture replacement reused its original inode: ${path}`);
  }
};

export const replaceFixtureDirectory = (path: string): void => {
  const before = statSync(path);
  const replacement = `${path}.replacement`;
  mkdirSync(replacement);
  rmSync(path, { recursive: true });
  renameSync(replacement, path);
  assertIdentityChanged(before, path);
};

export const replaceFixtureFile = (
  path: string,
  contents: string,
  mode?: number,
): void => {
  const before = statSync(path);
  const replacement = `${path}.replacement`;
  writeFileSync(replacement, contents, { mode });
  unlinkSync(path);
  renameSync(replacement, path);
  assertIdentityChanged(before, path);
};

export const requiredState = (
  states: ReadonlyMap<string, FileState>,
  rel: string,
): FileState => {
  const state = states.get(rel);
  if (state === undefined) {
    throw new Error(`Missing test preflight state: ${rel}`);
  }
  return state;
};

export const writeTransactionOwnerFixture = (
  root: string,
  transaction: string,
  id: string,
): void => {
  const rootInfo = statSync(root);
  const transactionInfo = statSync(transaction);
  writeFileSync(
    join(transaction, TRANSACTION_OWNER),
    JSON.stringify({
      id,
      root: { dev: String(rootInfo.dev), ino: String(rootInfo.ino) },
      transaction: {
        dev: String(transactionInfo.dev),
        ino: String(transactionInfo.ino),
      },
      version: 1,
    }),
  );
};

export const cleanupFixtures = (): void => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
};
