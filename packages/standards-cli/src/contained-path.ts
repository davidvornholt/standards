import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

const isContained = (root: string, candidate: string): boolean => {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== '' &&
    !isAbsolute(fromRoot) &&
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`)
  );
};

const matchesKind = (stat: Stats, kind: 'directory' | 'file'): boolean =>
  kind === 'file' ? stat.isFile() : stat.isDirectory();

// Validate the path component by component without following symlinks. Callers
// may read it only after this succeeds; the remaining check/read race is inside
// the package's non-hostile maintainer threat model.
export const isContainedPath = (
  consumer: string,
  rel: string,
  kind: 'directory' | 'file',
): boolean => {
  try {
    if (
      isAbsolute(rel) ||
      rel.includes('\\') ||
      lstatSync(consumer).isSymbolicLink()
    ) {
      return false;
    }
    const parts = rel.split('/');
    if (
      parts.length === 0 ||
      parts.some((part) => ['', '.', '..'].includes(part))
    ) {
      return false;
    }
    const root = realpathSync(consumer);
    let candidate = consumer;
    for (const [index, part] of parts.entries()) {
      candidate = join(candidate, part);
      const stat = lstatSync(candidate);
      const final = index === parts.length - 1;
      const expectedKind = final ? kind : 'directory';
      if (
        stat.isSymbolicLink() ||
        !isContained(root, realpathSync(candidate)) ||
        !matchesKind(stat, expectedKind)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
};
