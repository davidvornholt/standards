import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BUN_PACKAGE_MANAGER =
  /^bun@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const REQUIRED_FILES = ['.envrc', 'flake.nix', 'flake.lock'] as const;

export const collectDevShellProblems = (
  root: string,
  manifest: Record<string, unknown>,
): ReadonlyArray<string> => [
  ...(typeof manifest.packageManager === 'string' &&
  BUN_PACKAGE_MANAGER.test(manifest.packageManager)
    ? []
    : ['package.json: "packageManager" must pin an exact bun@x.y.z version']),
  ...REQUIRED_FILES.flatMap((path) =>
    existsSync(join(root, path))
      ? []
      : [`${path}: required for the Nix dev shell`],
  ),
];
