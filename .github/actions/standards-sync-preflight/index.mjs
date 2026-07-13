import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const POLICY_FILE = 'sync-standards.local.json';
const PACKAGE_FILE = 'package.json';
const STANDARDS_PACKAGE = '@davidvornholt/standards';
const DEFAULT_POLICY = {
  ref: 'refs/heads/main',
  scheduledSync: true,
};
const FULL_COMMIT_SHA = /^[0-9a-fA-F]{40}$/u;
const EXACT_STABLE_SEMVER =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)$/u;
const REQUIRED_MINOR_VERSION = 5n;
const REQUIRED_VERSION = [0n, REQUIRED_MINOR_VERSION, 0n];
const INVALID_REF_CHARACTERS = new Set(['~', '^', ':', '?', '*', '[', '\\']);
const SPACE_CODE_POINT = 32;
const DELETE_CODE_POINT = 127;

const parseJson = (path, label) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} must contain valid JSON`, { cause: error });
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

const loadPolicy = (workspace) => {
  const path = join(workspace, POLICY_FILE);
  if (!existsSync(path)) {
    return DEFAULT_POLICY;
  }
  const policy = parseJson(path, POLICY_FILE);
  if (!isRecord(policy)) {
    throw new Error(`${POLICY_FILE} must be a JSON object`);
  }
  if (typeof policy.ref !== 'string' || !isSupportedRef(policy.ref)) {
    throw new Error(
      `${POLICY_FILE} requires "ref" to be refs/heads/<branch>, refs/tags/<tag>, or a full commit SHA`,
    );
  }
  if (typeof policy.scheduledSync !== 'boolean') {
    throw new Error(`${POLICY_FILE} requires boolean "scheduledSync"`);
  }
  return { ref: policy.ref, scheduledSync: policy.scheduledSync };
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

const assertCompatibleCli = (workspace) => {
  const path = join(workspace, PACKAGE_FILE);
  const packageJson = existsSync(path)
    ? parseJson(path, PACKAGE_FILE)
    : undefined;
  const devDependencies = isRecord(packageJson)
    ? packageJson.devDependencies
    : undefined;
  const version = isRecord(devDependencies)
    ? devDependencies[STANDARDS_PACKAGE]
    : undefined;
  if (typeof version !== 'string' || !versionIsCompatible(version)) {
    throw new Error(
      `Non-default sync policy requires devDependencies["${STANDARDS_PACKAGE}"] to be an exact stable version >=0.5.0; run \`bun add --dev --exact ${STANDARDS_PACKAGE}@0.5.0\` before using the policy`,
    );
  }
};

const main = () => {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const outputFile = process.env.GITHUB_OUTPUT;
  const workspace = process.env.GITHUB_WORKSPACE;
  if (eventName !== 'schedule' && eventName !== 'workflow_dispatch') {
    throw new Error(
      `Unsupported Standards sync event: ${eventName ?? 'unset'}`,
    );
  }
  if (outputFile === undefined || outputFile.length === 0) {
    throw new Error('GITHUB_OUTPUT is required');
  }
  if (workspace === undefined || workspace.length === 0) {
    throw new Error('GITHUB_WORKSPACE is required');
  }

  const policy = loadPolicy(workspace);
  const isNonDefault =
    policy.ref !== DEFAULT_POLICY.ref ||
    policy.scheduledSync !== DEFAULT_POLICY.scheduledSync;
  if (isNonDefault) {
    assertCompatibleCli(workspace);
  }

  const runSync = eventName === 'workflow_dispatch' || policy.scheduledSync;
  appendFileSync(outputFile, `run_sync=${runSync}\n`);
  console.log(
    runSync
      ? 'standards: sync preflight enabled this run'
      : `standards: scheduled sync disabled by ${POLICY_FILE}`,
  );
};

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`standards: sync preflight failed: ${message}`);
  process.exitCode = 1;
}
