// Ownership questions about a destination path, asked before init/sync writes
// to it or deletes it. Both answers come from the lock: it is the only record of
// what this engine put in a consumer, so anything absent from it is consumer
// work that a mirror must never destroy.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectManagedPath, type ManagedEntry } from './managed-files';

const collectPaths = async (
  root: string,
  rel: string,
  found: Array<string>,
): Promise<void> => {
  const entry = await inspectManagedPath(join(root, rel));
  if (entry === null) {
    return;
  }
  if (entry.kind === 'directory') {
    const names = await readdir(join(root, rel));
    await Promise.all(
      names.map((name) => collectPaths(root, `${rel}/${name}`, found)),
    );
    return;
  }
  found.push(rel);
};

// Paths inside `rel` that the lock never recorded, so a caller can tell an
// engine-owned tree from consumer work. An older CLI that followed a canonical
// link materialized its whole target tree and locked every path in it; a
// consumer's own file under the same directory is absent from the lock. Nothing
// here follows a symlink: every entry is judged where it sits.
export const unlockedPathsUnder = async (
  root: string,
  rel: string,
  locked: ReadonlySet<string>,
): Promise<ReadonlyArray<string>> => {
  const found: Array<string> = [];
  await collectPaths(root, rel, found);
  return found.filter((path) => !locked.has(path)).sort();
};

// An ancestor that is not a directory, so nothing can sit below it under the
// name the lock recorded. The kind is part of the answer: below a symlink the
// name still resolves, to somebody else's content, while below a file it
// resolves to nothing at all.
export type InterposedAncestor = {
  readonly rel: string;
  readonly kind: 'file' | 'symlink';
};

// The shallowest ancestor of `rel` inside `root` that is not a directory, or
// null when the whole parent chain is directories.
//
// `planned` is the payload this run mirrors, and it wins over the disk: every
// path in it has the kind upstream gives it once the mirror has finished, and
// the caller runs after the mirror. A dry run, which writes nothing, therefore
// reaches the same answer the matching real run does.
//
// A path whose parent chain crosses a link does not name what the caller thinks
// it names: reading or removing it reaches into the link's target tree, which
// is somebody else's content.
export const interposedAncestor = async (
  root: string,
  rel: string,
  planned: ReadonlyMap<string, ManagedEntry>,
): Promise<InterposedAncestor | null> => {
  const segments = rel.split('/').slice(0, -1);
  const prefixes = segments.map((_, depth) =>
    segments.slice(0, depth + 1).join('/'),
  );
  const entries = await Promise.all(
    prefixes.map(
      (prefix) => planned.get(prefix) ?? inspectManagedPath(join(root, prefix)),
    ),
  );
  for (const [index, prefix] of prefixes.entries()) {
    const entry = entries[index] ?? null;
    if (entry !== null && entry.kind !== 'directory') {
      return { rel: prefix, kind: entry.kind };
    }
  }
  return null;
};
