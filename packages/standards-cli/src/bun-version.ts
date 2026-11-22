// Bun versions as the standards pin them: exact `x.y.z` releases, compared
// numerically.

import { readFile } from 'node:fs/promises';
import { isRecord } from './github-settings-parse';

export const VERSION = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)`;
const STABLE_VERSION = new RegExp(`^${VERSION}$`, 'u');
const PACKAGE_MANAGER = new RegExp(`^bun@(?<version>${VERSION})$`, 'u');

export const compareVersions = (left: string, right: string): number => {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < a.length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

export const isStableVersion = (version: string): boolean =>
  STABLE_VERSION.test(version);

// The version a manifest's `packageManager` pins, or null when it doesn't pin
// an exact Bun release.
export const packageManagerBunVersion = (manifest: unknown): string | null => {
  const value = isRecord(manifest) ? manifest.packageManager : undefined;
  return typeof value === 'string'
    ? (PACKAGE_MANAGER.exec(value)?.groups?.version ?? null)
    : null;
};

export const readBunVersion = async (path: string): Promise<string | null> => {
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) {
    return null;
  }
  try {
    return packageManagerBunVersion(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
};
