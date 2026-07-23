import { Buffer } from 'node:buffer';

const SLSA_PROVENANCE_TYPE = 'https://slsa.dev/provenance/v1';
const BASE64_PAYLOAD = /^[A-Za-z0-9+/]*={0,2}$/u;
const BASE64_PADDING = /[=]+$/u;

type JsonRecord = Readonly<Record<string, unknown>>;

export type ProvenanceExpectation = {
  readonly packageName: string;
  readonly version: string;
  readonly repository: string;
  readonly workflowPath: string;
  readonly commit: string;
};

export type GithubReleaseState = 'draft' | 'missing' | 'published' | 'tag-only';

export type ReconciliationPlan =
  | { readonly action: 'create' | 'none'; readonly problem: null }
  | { readonly action: null; readonly problem: string };

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const recordAt = (
  record: JsonRecord | null,
  key: string,
): JsonRecord | null => {
  const value = record?.[key];
  return isRecord(value) ? value : null;
};

const arrayAt = (
  record: JsonRecord | null,
  key: string,
): ReadonlyArray<unknown> | null => {
  const value = record?.[key];
  return Array.isArray(value) ? value : null;
};

const stringAt = (record: JsonRecord | null, key: string): string | null => {
  const value = record?.[key];
  return typeof value === 'string' ? value : null;
};

const decodeStatement = (attestation: JsonRecord): JsonRecord | null => {
  const payload = stringAt(
    recordAt(recordAt(attestation, 'bundle'), 'dsseEnvelope'),
    'payload',
  );
  if (payload === null || !BASE64_PAYLOAD.test(payload)) {
    return null;
  }
  try {
    const decoded = Buffer.from(payload, 'base64');
    const normalizedPayload = payload.replace(BASE64_PADDING, '');
    if (
      decoded.toString('base64').replace(BASE64_PADDING, '') !==
      normalizedPayload
    ) {
      return null;
    }
    const parsed: unknown = JSON.parse(decoded.toString('utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const workflowPathFromRef = (
  repository: string,
  workflowRef: string,
): string | null => {
  const prefix = `${repository}/`;
  const refSeparator = workflowRef.lastIndexOf('@');
  if (!workflowRef.startsWith(prefix) || refSeparator <= prefix.length) {
    return null;
  }
  return workflowRef.slice(prefix.length, refSeparator);
};

export const provenanceProblems = (
  response: unknown,
  expected: ProvenanceExpectation,
): ReadonlyArray<string> => {
  if (!isRecord(response)) {
    return ['npm attestation response must be a JSON object'];
  }
  const attestations = arrayAt(response, 'attestations');
  if (attestations === null) {
    return ['npm attestation response must contain an attestations array'];
  }
  const provenance = attestations.filter(
    (value): value is JsonRecord =>
      isRecord(value) &&
      stringAt(value, 'predicateType') === SLSA_PROVENANCE_TYPE,
  );
  if (provenance.length !== 1) {
    return [
      `npm package must have exactly one SLSA provenance attestation; found ${provenance.length}`,
    ];
  }

  const statement = decodeStatement(provenance[0]);
  if (statement === null) {
    return ['npm SLSA provenance payload must be valid base64-encoded JSON'];
  }
  const problems: Array<string> = [];
  if (stringAt(statement, 'predicateType') !== SLSA_PROVENANCE_TYPE) {
    problems.push('npm SLSA statement predicate type is invalid');
  }

  const predicate = recordAt(statement, 'predicate');
  const buildDefinition = recordAt(predicate, 'buildDefinition');
  const externalParameters = recordAt(buildDefinition, 'externalParameters');
  const workflow = recordAt(externalParameters, 'workflow');
  if (stringAt(workflow, 'repository') !== expected.repository) {
    problems.push(`npm provenance repository must be ${expected.repository}`);
  }
  if (stringAt(workflow, 'path') !== expected.workflowPath) {
    problems.push(`npm provenance workflow must be ${expected.workflowPath}`);
  }

  const dependencies = arrayAt(buildDefinition, 'resolvedDependencies');
  const expectedUriPrefix = `git+${expected.repository}@`;
  const resolvedSource =
    dependencies?.filter(
      (value): value is JsonRecord =>
        isRecord(value) &&
        stringAt(value, 'uri')?.startsWith(expectedUriPrefix) === true,
    ) ?? [];
  if (resolvedSource.length !== 1) {
    problems.push(
      `npm provenance must resolve exactly one source from ${expected.repository}`,
    );
  } else if (
    stringAt(recordAt(resolvedSource[0], 'digest'), 'gitCommit') !==
    expected.commit
  ) {
    problems.push(`npm provenance resolved commit must be ${expected.commit}`);
  }

  const subjectName = `pkg:npm/${encodeURIComponent(expected.packageName).replace('%2F', '/')}@${expected.version}`;
  const subjects = arrayAt(statement, 'subject');
  if (
    subjects?.some(
      (subject) =>
        isRecord(subject) && stringAt(subject, 'name') === subjectName,
    ) !== true
  ) {
    problems.push(`npm provenance subject must be ${subjectName}`);
  }
  return problems;
};

export const githubReconciliationPlan = (
  state: GithubReleaseState,
  tagSha: string | null,
  expectedSha: string,
): ReconciliationPlan => {
  if (state === 'draft') {
    return {
      action: null,
      problem: 'Release already exists as a draft',
    };
  }
  if (state === 'missing') {
    return { action: 'create', problem: null };
  }
  if (tagSha !== expectedSha) {
    return {
      action: null,
      problem: `Release tag points to ${tagSha ?? 'no commit'}, expected ${expectedSha}`,
    };
  }
  return {
    action: state === 'published' ? 'none' : 'create',
    problem: null,
  };
};
