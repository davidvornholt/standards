import { lstatSync } from 'node:fs';
import { join } from 'node:path';

const BUN_PACKAGE_MANAGER =
  /^bun@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const REQUIRED_FILES = ['.envrc', 'flake.nix', 'flake.lock'] as const;
const isRegularFile = (path: string): boolean => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

export const collectDevShellProblems = (
  root: string,
  manifest: Record<string, unknown>,
): ReadonlyArray<string> => [
  ...(typeof manifest.packageManager === 'string' &&
  BUN_PACKAGE_MANAGER.test(manifest.packageManager)
    ? []
    : ['package.json: "packageManager" must pin an exact bun@x.y.z version']),
  ...REQUIRED_FILES.flatMap((path) =>
    isRegularFile(join(root, path))
      ? []
      : [`${path}: required for the Nix dev shell`],
  ),
];
