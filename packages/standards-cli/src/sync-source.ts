export const STANDARDS_PACKAGE = '@davidvornholt/standards';
export const STANDARDS_SOURCE_PACKAGE_FILE =
  'packages/standards-cli/package.json';

const SOURCE_WORKSPACE_FIELD = 'standardsSourceWorkspace';
const SOURCE_WORKSPACE_PATH = 'packages/standards-cli';
const EXACT_STABLE_SEMVER =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)$/u;
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

const workspaceOwnsSource = (workspaces: unknown): boolean =>
  Array.isArray(workspaces) &&
  workspaces.some(
    (workspace) =>
      workspace === SOURCE_WORKSPACE_PATH ||
      workspace ===
        `${SOURCE_WORKSPACE_PATH.slice(0, SOURCE_WORKSPACE_PATH.lastIndexOf('/'))}/*`,
  );

export const isStandardsSourceWorkspace = (
  rootPackage: Record<string, unknown>,
  sourcePackage: unknown,
  syncPolicyContractVersion: number,
): boolean => {
  const sourceDeclaration = rootPackage[SOURCE_WORKSPACE_FIELD];
  if (!(isRecord(sourceDeclaration) && isRecord(sourcePackage))) {
    return false;
  }
  const { bin, exports, repository } = sourcePackage;
  return (
    rootPackage.name === 'standards' &&
    rootPackage.private === true &&
    sourceDeclaration.path === SOURCE_WORKSPACE_PATH &&
    sourceDeclaration.syncPolicyContractVersion === syncPolicyContractVersion &&
    workspaceOwnsSource(rootPackage.workspaces) &&
    sourcePackage.name === STANDARDS_PACKAGE &&
    typeof sourcePackage.version === 'string' &&
    versionIsCompatible(sourcePackage.version) &&
    isRecord(repository) &&
    repository.directory === sourceDeclaration.path &&
    isRecord(bin) &&
    bin.standards === 'src/cli.ts' &&
    isRecord(exports) &&
    Object.keys(exports).length === 0
  );
};
