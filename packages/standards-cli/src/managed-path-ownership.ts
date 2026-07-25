// Ownership questions about a destination path, asked before init/sync writes
// to it or deletes it. Both answers come from the lock: it is the only record of
// what this engine put in a consumer, so anything absent from it is consumer
// work that a mirror must never destroy.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectManagedPath } from './managed-files';

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

// The first ancestor of `rel` inside `root` that is a symlink, or null when the
// whole parent chain is real directories. A path whose parent chain crosses a
// link does not name what the caller thinks it names: reading or removing it
// reaches into the link's target tree, which is somebody else's content.
export const symlinkedAncestor = async (
  root: string,
  rel: string,
): Promise<string | null> => {
  const segments = rel.split('/').slice(0, -1);
  const prefixes = segments.map((_, depth) =>
    segments.slice(0, depth + 1).join('/'),
  );
  const entries = await Promise.all(
    prefixes.map((prefix) => inspectManagedPath(join(root, prefix))),
  );
  const index = entries.findIndex((entry) => entry?.kind === 'symlink');
  return index === -1 ? null : (prefixes[index] ?? null);
};
