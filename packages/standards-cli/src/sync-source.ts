import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const STANDARDS_PACKAGE = '@davidvornholt/standards';

const ROOT_PACKAGE_NAME = 'standards';
const EXACT_STABLE_SEMVER =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)$/u;
const SIMPLE_WORKSPACE_SEGMENT = /^[A-Za-z0-9@._-]+$/u;
const REQUIRED_MINOR_VERSION = 5n;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const versionIsCompatible = (version: string): boolean => {
  const { major, minor } = EXACT_STABLE_SEMVER.exec(version)?.groups ?? {};
  return (
    major !== undefined &&
    minor !== undefined &&
    (BigInt(major) > 0n || BigInt(minor) >= REQUIRED_MINOR_VERSION)
  );
};

const isSimpleWorkspacePath = (path: string): boolean =>
  path.length > 0 &&
  path
    .split('/')
    .every(
      (segment) =>
        segment !== '.' &&
        segment !== '..' &&
        SIMPLE_WORKSPACE_SEGMENT.test(segment),
    );

const pathsForWorkspace = (
  rootDirectory: string,
  workspace: unknown,
): ReadonlyArray<string> | null => {
  if (typeof workspace !== 'string') {
    return null;
  }
  const wildcard = workspace.endsWith('/*');
  const base = wildcard ? workspace.slice(0, -2) : workspace;
  if (!isSimpleWorkspacePath(base) || (!wildcard && workspace.includes('*'))) {
    return null;
  }
  if (!wildcard) {
    return [base];
  }
  try {
    return readdirSync(join(rootDirectory, base), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${base}/${entry.name}`)
      .sort();
  } catch {
    return null;
  }
};

const workspaceDirectories = (
  rootDirectory: string,
  workspaces: unknown,
): ReadonlyArray<string> | null => {
  if (!(Array.isArray(workspaces) && workspaces.length > 0)) {
    return null;
  }
  const directories: Array<string> = [];
  const seen = new Set<string>();
  for (const workspace of workspaces) {
    const paths = pathsForWorkspace(rootDirectory, workspace);
    if (paths === null) {
      return null;
    }
    for (const path of paths) {
      if (seen.has(path)) {
        return null;
      }
      seen.add(path);
      directories.push(path);
    }
  }
  return directories;
};

const readWorkspacePackages = (
  rootDirectory: string,
  workspaces: unknown,
): ReadonlyArray<readonly [string, Record<string, unknown>]> | null => {
  const directories = workspaceDirectories(rootDirectory, workspaces);
  if (directories === null) {
    return null;
  }
  const packages: Array<readonly [string, Record<string, unknown>]> = [];
  for (const directory of directories) {
    try {
      const parsed = JSON.parse(
        readFileSync(join(rootDirectory, directory, 'package.json'), 'utf8'),
      ) as unknown;
      if (!isRecord(parsed)) {
        return null;
      }
      packages.push([directory, parsed]);
    } catch {
      return null;
    }
  }
  return packages;
};

const isStandardsPackage = (
  path: string,
  packageJson: Record<string, unknown>,
): boolean => {
  const { bin, exports, repository, version } = packageJson;
  return (
    packageJson.name === STANDARDS_PACKAGE &&
    typeof version === 'string' &&
    versionIsCompatible(version) &&
    isRecord(repository) &&
    repository.directory === path &&
    isRecord(bin) &&
    bin.standards === 'src/cli.ts' &&
    isRecord(exports) &&
    Object.keys(exports).length === 0
  );
};

export const isStandardsSourceWorkspace = (
  rootPackage: Record<string, unknown>,
  rootDirectory: string | undefined,
): boolean => {
  if (
    rootDirectory === undefined ||
    rootPackage.name !== ROOT_PACKAGE_NAME ||
    rootPackage.private !== true
  ) {
    return false;
  }
  const packages = readWorkspacePackages(rootDirectory, rootPackage.workspaces);
  if (packages === null) {
    return false;
  }
  const standardsPackages = packages.filter(
    ([, packageJson]) => packageJson.name === STANDARDS_PACKAGE,
  );
  const [candidate] = standardsPackages;
  return (
    standardsPackages.length === 1 &&
    candidate !== undefined &&
    isStandardsPackage(...candidate)
  );
};
