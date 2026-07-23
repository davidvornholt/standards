import { Buffer } from 'node:buffer';

export const SLSA_PROVENANCE_TYPE = 'https://slsa.dev/provenance/v1';

const IN_TOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
const GITHUB_ACTIONS_BUILD_TYPE =
  'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1';
const BASE64_PAYLOAD = /^[A-Za-z0-9+/]*={0,2}$/u;
const BASE64_PADDING = /[=]+$/u;
const SHA512_BYTE_LENGTH = 64;
const HEX_RADIX = 16;
const HEX_BYTE_WIDTH = 2;

export type JsonRecord = Readonly<Record<string, unknown>>;

export type ProvenanceExpectation = {
  readonly packageName: string;
  readonly version: string;
  readonly repository: string;
  readonly workflowPath: string;
  readonly commit: string;
  readonly installedIntegrity: string;
};

export const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const jsonRecordAt = (
  record: JsonRecord | null,
  key: string,
): JsonRecord | null => {
  const value = record?.[key];
  return isJsonRecord(value) ? value : null;
};

export const jsonArrayAt = (
  record: JsonRecord | null,
  key: string,
): ReadonlyArray<unknown> | null => {
  const value = record?.[key];
  return Array.isArray(value) ? value : null;
};

export const jsonStringAt = (
  record: JsonRecord | null,
  key: string,
): string | null => {
  const value = record?.[key];
  return typeof value === 'string' ? value : null;
};

const strictBase64 = (value: string): Buffer | null => {
  if (!BASE64_PAYLOAD.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64').replace(BASE64_PADDING, '') ===
    value.replace(BASE64_PADDING, '')
    ? decoded
    : null;
};

export const decodeVerifiedStatement = (
  bundle: JsonRecord,
): JsonRecord | null => {
  const payload = jsonStringAt(jsonRecordAt(bundle, 'dsseEnvelope'), 'payload');
  if (payload === null) {
    return null;
  }
  const decoded = strictBase64(payload);
  if (decoded === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(decoded));
    return isJsonRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const installedSha512 = (integrity: string): string | null => {
  const prefix = 'sha512-';
  if (!integrity.startsWith(prefix)) {
    return null;
  }
  const digest = strictBase64(integrity.slice(prefix.length));
  return digest?.length === SHA512_BYTE_LENGTH
    ? Array.from(digest, (byte) =>
        byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, '0'),
      ).join('')
    : null;
};

export const workflowPathFromRef = (
  repository: string,
  workflowRef: string,
): string | null => {
  const prefix = `${repository}/`;
  const refSeparator = workflowRef.lastIndexOf('@');
  return workflowRef.startsWith(prefix) && refSeparator > prefix.length
    ? workflowRef.slice(prefix.length, refSeparator)
    : null;
};

export const verifiedStatementProblems = (
  statement: JsonRecord,
  expected: ProvenanceExpectation,
): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  if (jsonStringAt(statement, '_type') !== IN_TOTO_STATEMENT_TYPE) {
    problems.push('npm provenance must be an in-toto v1 statement');
  }
  if (jsonStringAt(statement, 'predicateType') !== SLSA_PROVENANCE_TYPE) {
    problems.push('npm SLSA statement predicate type is invalid');
  }
  const build = jsonRecordAt(
    jsonRecordAt(statement, 'predicate'),
    'buildDefinition',
  );
  if (jsonStringAt(build, 'buildType') !== GITHUB_ACTIONS_BUILD_TYPE) {
    problems.push('npm provenance build type must be GitHub Actions workflow');
  }
  const workflow = jsonRecordAt(
    jsonRecordAt(build, 'externalParameters'),
    'workflow',
  );
  if (jsonStringAt(workflow, 'repository') !== expected.repository) {
    problems.push(`npm provenance repository must be ${expected.repository}`);
  }
  if (jsonStringAt(workflow, 'path') !== expected.workflowPath) {
    problems.push(`npm provenance workflow must be ${expected.workflowPath}`);
  }
  const sourcePrefix = `git+${expected.repository}@`;
  const sources =
    jsonArrayAt(build, 'resolvedDependencies')?.filter(
      (value): value is JsonRecord =>
        isJsonRecord(value) &&
        jsonStringAt(value, 'uri')?.startsWith(sourcePrefix) === true,
    ) ?? [];
  if (sources.length !== 1) {
    problems.push(
      `npm provenance must resolve exactly one source from ${expected.repository}`,
    );
  } else if (
    jsonStringAt(jsonRecordAt(sources[0], 'digest'), 'gitCommit') !==
    expected.commit
  ) {
    problems.push(`npm provenance resolved commit must be ${expected.commit}`);
  }
  const subjectName = `pkg:npm/${encodeURIComponent(expected.packageName).replace('%2F', '/')}@${expected.version}`;
  const subjects = jsonArrayAt(statement, 'subject');
  if (subjects?.length !== 1 || !isJsonRecord(subjects[0])) {
    problems.push('npm provenance must contain exactly one package subject');
    return problems;
  }
  if (jsonStringAt(subjects[0], 'name') !== subjectName) {
    problems.push(`npm provenance subject must be ${subjectName}`);
  }
  const installedDigest = installedSha512(expected.installedIntegrity);
  if (installedDigest === null) {
    problems.push('Installed package integrity must be a valid sha512 digest');
  } else if (
    jsonStringAt(jsonRecordAt(subjects[0], 'digest'), 'sha512') !==
    installedDigest
  ) {
    problems.push('npm provenance subject digest must match installed package');
  }
  return problems;
};
