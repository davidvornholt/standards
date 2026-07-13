export const DEFAULT_SYNC_POLICY = {
  ref: 'refs/heads/main',
  scheduledSync: true,
};

export const SYNC_POLICY_CONTRACT_VERSION = 1;

const POLICY_FILE = 'sync-standards.local.json';
const PACKAGE_FILE = 'package.json';
const STANDARDS_PACKAGE = '@davidvornholt/standards';
const FULL_COMMIT_SHA = /^[0-9a-fA-F]{40}$/u;
const EXACT_STABLE_SEMVER =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)$/u;
const REQUIRED_MINOR_VERSION = 5n;
const REQUIRED_VERSION = [0n, REQUIRED_MINOR_VERSION, 0n];
const INVALID_REF_CHARACTERS = new Set(['~', '^', ':', '?', '*', '[', '\\']);
const SPACE_CODE_POINT = 32;
const DELETE_CODE_POINT = 127;

const parseJson = (text, label, problems) => {
  try {
    return JSON.parse(text);
  } catch {
    problems.push(`${label} must contain valid JSON`);
    return undefined;
  }
};

const isRecord = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSupportedRef = (ref) => {
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

const inspectPolicy = (policyText, problems) => {
  if (policyText === undefined) {
    return { policy: DEFAULT_SYNC_POLICY, requestsNonDefault: false };
  }
  const raw = parseJson(policyText, POLICY_FILE, problems);
  if (raw === undefined) {
    return { policy: null, requestsNonDefault: false };
  }
  if (!isRecord(raw)) {
    problems.push(`${POLICY_FILE} must be a JSON object`);
    return { policy: null, requestsNonDefault: false };
  }

  const requestsNonDefault =
    (typeof raw.ref === 'string' && raw.ref !== DEFAULT_SYNC_POLICY.ref) ||
    raw.scheduledSync === false;
  const refIsValid =
    typeof raw.ref === 'string' && isSupportedRef(raw.ref);
  const scheduledSyncIsValid = typeof raw.scheduledSync === 'boolean';
  if (!refIsValid) {
    problems.push(
      `${POLICY_FILE} requires "ref" to be refs/heads/<branch>, refs/tags/<tag>, or a full commit SHA`,
    );
  }
  if (!scheduledSyncIsValid) {
    problems.push(`${POLICY_FILE} requires boolean "scheduledSync"`);
  }
  if (!(refIsValid && scheduledSyncIsValid)) {
    return { policy: null, requestsNonDefault };
  }
  return {
    policy: { ref: raw.ref, scheduledSync: raw.scheduledSync },
    requestsNonDefault,
  };
};

const versionIsCompatible = (version) => {
  const match = EXACT_STABLE_SEMVER.exec(version);
  if (match === null) {
    return false;
  }
  const { major, minor, patch } = match.groups ?? {};
  if (major === undefined || minor === undefined || patch === undefined) {
    return false;
  }
  const actual = [major, minor, patch].map((part) => BigInt(part));
  for (const [index, required] of REQUIRED_VERSION.entries()) {
    const component = actual[index];
    if (component === undefined) {
      return false;
    }
    if (component !== required) {
      return component > required;
    }
  }
  return true;
};

export const inspectSyncPolicy = ({
  packageText,
  policyText,
  requireDirectPackage,
}) => {
  const problems = [];
  const { policy, requestsNonDefault } = inspectPolicy(policyText, problems);
  const inspectPackage = requireDirectPackage || requestsNonDefault;
  let packageJson;

  if (inspectPackage) {
    if (packageText === undefined) {
      if (requestsNonDefault) {
        problems.push(
          `Non-default sync policy requires devDependencies["${STANDARDS_PACKAGE}"] to be an exact stable version >=0.5.0; run \`bun add --dev --exact ${STANDARDS_PACKAGE}@0.5.0\` before using the policy`,
        );
      } else {
        problems.push(`${PACKAGE_FILE} must exist`);
      }
    } else {
      packageJson = parseJson(packageText, PACKAGE_FILE, problems);
      if (packageJson !== undefined && !isRecord(packageJson)) {
        problems.push(`${PACKAGE_FILE} must be a JSON object`);
        packageJson = undefined;
      }
      if (packageJson !== undefined) {
        const devDependencies = isRecord(packageJson.devDependencies)
          ? packageJson.devDependencies
          : undefined;
        const version = devDependencies?.[STANDARDS_PACKAGE];
        if (requestsNonDefault) {
          if (typeof version !== 'string' || !versionIsCompatible(version)) {
            problems.push(
              `Non-default sync policy requires devDependencies["${STANDARDS_PACKAGE}"] to be an exact stable version >=0.5.0; run \`bun add --dev --exact ${STANDARDS_PACKAGE}@0.5.0\` before using the policy`,
            );
          }
        } else if (typeof version !== 'string') {
          problems.push(
            `${PACKAGE_FILE} must declare ${STANDARDS_PACKAGE} directly`,
          );
        }
      }
    }
  }

  return { packageJson, policy, problems };
};
