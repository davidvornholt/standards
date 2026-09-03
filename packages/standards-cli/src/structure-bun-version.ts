import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BUN_PACKAGE_MANAGER =
  /^bun@(?<version>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u;
const PACKAGE_MANAGER_PROBLEM =
  'package.json: "packageManager" must pin an exact bun@x.y.z version';
const MISE_PATH = 'mise.toml';

const packageManagerVersion = (
  manifest: Record<string, unknown>,
): string | null => {
  if (typeof manifest.packageManager !== 'string') {
    return null;
  }
  return (
    BUN_PACKAGE_MANAGER.exec(manifest.packageManager)?.groups?.version ?? null
  );
};

const miseBunVersion = (configuration: unknown): string | null => {
  if (
    typeof configuration !== 'object' ||
    configuration === null ||
    !('tools' in configuration) ||
    typeof configuration.tools !== 'object' ||
    configuration.tools === null ||
    !('bun' in configuration.tools) ||
    typeof configuration.tools.bun !== 'string'
  ) {
    return null;
  }
  return configuration.tools.bun;
};

const collectMiseProblems = async (
  root: string,
  expectedVersion: string | null,
): Promise<ReadonlyArray<string>> => {
  const path = join(root, MISE_PATH);
  if (!existsSync(path)) {
    return [];
  }
  let configuration: unknown;
  try {
    configuration = await import(path);
  } catch {
    return [`${MISE_PATH}: must contain valid TOML`];
  }
  const version = miseBunVersion(configuration);
  if (version === null) {
    return [`${MISE_PATH}: tools.bun must be a version string`];
  }
  return expectedVersion === null || version === expectedVersion
    ? []
    : [
        `${MISE_PATH}: tools.bun must match package.json packageManager (${expectedVersion})`,
      ];
};

export const collectBunVersionProblems = async (
  root: string,
  manifest: Record<string, unknown>,
): Promise<ReadonlyArray<string>> => {
  const version = packageManagerVersion(manifest);
  return [
    ...(version === null ? [PACKAGE_MANAGER_PROBLEM] : []),
    ...(await collectMiseProblems(root, version)),
  ];
};
