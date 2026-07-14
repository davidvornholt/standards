export type SyncPolicy = {
  readonly ref: string;
  readonly scheduledSync: boolean;
};

export type SyncPolicyInspection = {
  readonly packageJson: Record<string, unknown> | undefined;
  readonly policy: SyncPolicy | null;
  readonly problems: ReadonlyArray<string>;
};

type SyncPolicyInspectionInput = {
  readonly packageText: string | undefined;
  readonly policyText: string | undefined;
  readonly sourceWorkspacePackageText: string | undefined;
};

export const DEFAULT_SYNC_POLICY: SyncPolicy = {
  ref: 'refs/heads/main',
  scheduledSync: true,
};

export const SYNC_POLICY_CONTRACT_VERSION = 1;
export const SYNC_POLICY_FILE = 'sync-standards.local.json';
export const STANDARDS_SOURCE_PACKAGE_FILE =
  'packages/standards-cli/package.json';

const PACKAGE_FILE = 'package.json';
const STANDARDS_PACKAGE = '@davidvornholt/standards';
const FULL_COMMIT_SHA = /^[0-9a-fA-F]{40}$/u;
const EXACT_STABLE_SEMVER =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)$/u;
const REQUIRED_MINOR_VERSION = 5n;
const INVALID_REF_CHARACTERS = new Set(['~', '^', ':', '?', '*', '[', '\\']);
const SPACE_CODE_POINT = 32;
const DELETE_CODE_POINT = 127;
const POLICY_KEYS = new Set(['ref', 'scheduledSync']);

const compatiblePackageProblem = (): string =>
  `${PACKAGE_FILE} must declare devDependencies["${STANDARDS_PACKAGE}"] as an exact stable version >=0.5.0; run \`bun add --dev --exact ${STANDARDS_PACKAGE}@0.5.0\` before using sync policy`;

const parseJson = (
  text: string,
  label: string,
  problems: Array<string>,
): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    problems.push(`${label} must contain valid JSON`);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSupportedRef = (ref: string): boolean => {
  if (FULL_COMMIT_SHA.test(ref)) {
    return true;
  }
  if (!(ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/'))) {
    return false;
  }
  if (
    ref.includes('..') ||
    ref.includes('@{') ||
    ref.includes('//') ||
    ref.endsWith('.')
  ) {
    return false;
  }
  for (const character of ref) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= SPACE_CODE_POINT ||
      codePoint === DELETE_CODE_POINT ||
      INVALID_REF_CHARACTERS.has(character)
    ) {
      return false;
    }
  }
  return ref
    .split('/')
    .every(
      (component) =>
        component.length > 0 &&
        !component.startsWith('.') &&
        !component.endsWith('.lock'),
    );
};

const inspectPolicy = (
  policyText: string | undefined,
  problems: Array<string>,
): SyncPolicy | null => {
  if (policyText === undefined) {
    return DEFAULT_SYNC_POLICY;
  }
  const raw = parseJson(policyText, SYNC_POLICY_FILE, problems);
  if (raw === undefined) {
    return null;
  }
  if (!isRecord(raw)) {
    problems.push(`${SYNC_POLICY_FILE} must be a JSON object`);
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!POLICY_KEYS.has(key)) {
      problems.push(`${SYNC_POLICY_FILE} has unknown key "${key}"`);
    }
  }
  const refIsValid = typeof raw.ref === 'string' && isSupportedRef(raw.ref);
  const scheduledSyncIsValid = typeof raw.scheduledSync === 'boolean';
  if (!refIsValid) {
    problems.push(
      `${SYNC_POLICY_FILE} requires "ref" to be refs/heads/<branch>, refs/tags/<tag>, or a full commit SHA`,
    );
  }
  if (!scheduledSyncIsValid) {
    problems.push(`${SYNC_POLICY_FILE} requires boolean "scheduledSync"`);
  }
  return refIsValid && scheduledSyncIsValid
    ? { ref: raw.ref as string, scheduledSync: raw.scheduledSync as boolean }
    : null;
};

const versionIsCompatible = (version: string): boolean => {
  const match = EXACT_STABLE_SEMVER.exec(version);
  if (match === null) {
    return false;
  }
  const { major, minor } = match.groups ?? {};
  return (
    major !== undefined &&
    minor !== undefined &&
    (BigInt(major) > 0n || BigInt(minor) >= REQUIRED_MINOR_VERSION)
  );
};

const isStandardsSourceWorkspace = (
  packageJson: Record<string, unknown>,
  sourceWorkspacePackageText: string | undefined,
): boolean => {
  const sourcePackage =
    sourceWorkspacePackageText === undefined
      ? undefined
      : parseJson(
          sourceWorkspacePackageText,
          STANDARDS_SOURCE_PACKAGE_FILE,
          [],
        );
  const { scripts: rawScripts, workspaces } = packageJson;
  const scripts = isRecord(rawScripts) ? rawScripts : undefined;
  return (
    packageJson.name === 'standards' &&
    packageJson.private === true &&
    Array.isArray(workspaces) &&
    workspaces.includes('packages/*') &&
    scripts?.standards === 'bun packages/standards-cli/src/cli.ts' &&
    isRecord(sourcePackage) &&
    sourcePackage.name === STANDARDS_PACKAGE &&
    typeof sourcePackage.version === 'string' &&
    versionIsCompatible(sourcePackage.version) &&
    isRecord(sourcePackage.bin) &&
    sourcePackage.bin.standards === 'src/cli.ts'
  );
};

export const inspectSyncPolicy = ({
  packageText,
  policyText,
  sourceWorkspacePackageText,
}: SyncPolicyInspectionInput): SyncPolicyInspection => {
  const problems: Array<string> = [];
  const policy = inspectPolicy(policyText, problems);
  if (packageText === undefined) {
    problems.push(compatiblePackageProblem());
    return { packageJson: undefined, policy, problems };
  }
  const parsedPackage = parseJson(packageText, PACKAGE_FILE, problems);
  if (parsedPackage !== undefined && !isRecord(parsedPackage)) {
    problems.push(`${PACKAGE_FILE} must be a JSON object`);
  }
  const packageJson = isRecord(parsedPackage) ? parsedPackage : undefined;
  if (packageJson !== undefined) {
    const devDependencies = isRecord(packageJson.devDependencies)
      ? packageJson.devDependencies
      : undefined;
    const version = devDependencies?.[STANDARDS_PACKAGE];
    if (
      (typeof version !== 'string' || !versionIsCompatible(version)) &&
      !isStandardsSourceWorkspace(packageJson, sourceWorkspacePackageText)
    ) {
      problems.push(compatiblePackageProblem());
    }
  }
  return { packageJson, policy, problems };
};
