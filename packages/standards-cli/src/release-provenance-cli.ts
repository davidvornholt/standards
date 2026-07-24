import { readFileSync } from 'node:fs';
import { verifyProvenance } from './release-provenance.ts';
import { workflowPathFromRef } from './release-provenance-claims.ts';
import type { ProvenanceVerificationResult } from './release-recovery.ts';

type ProvenanceArguments = readonly [
  path: string,
  packageName: string,
  version: string,
  repository: string,
  serverUrl: string,
  workflowRef: string,
  commit: string,
  installedIntegrity: string,
  tufCachePath: string,
];
const PROVENANCE_ARGUMENT_COUNT: ProvenanceArguments['length'] = 9;

const hasProvenanceArguments = (
  values: ReadonlyArray<string>,
): values is ProvenanceArguments =>
  values.length === PROVENANCE_ARGUMENT_COUNT &&
  values.every((argument) => argument.length > 0);

// Imported lazily by the dispatcher so the pure release-planning commands stay
// runnable from a source-only tree that has never installed Sigstore.
export const verifyProvenanceArguments = (
  values: ReadonlyArray<string>,
): Promise<ProvenanceVerificationResult> => {
  if (!hasProvenanceArguments(values)) {
    return Promise.resolve({
      kind: 'malformed-provenance',
      message:
        'Provenance verification requires a response path, installed integrity, TUF cache, and complete GitHub release context',
    });
  }
  const [
    path,
    packageName,
    version,
    repository,
    serverUrl,
    workflowRef,
    commit,
    installedIntegrity,
    tufCachePath,
  ] = values;
  let response: unknown;
  try {
    response = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return Promise.resolve({
      kind: 'malformed-provenance',
      message: 'npm attestation response must contain valid JSON',
    });
  }
  const workflowPath = workflowPathFromRef(repository, workflowRef);
  if (workflowPath === null) {
    return Promise.resolve({
      kind: 'malformed-provenance',
      message: `Invalid GitHub workflow ref: ${workflowRef}`,
    });
  }
  return verifyProvenance(
    response,
    {
      commit,
      installedIntegrity,
      packageName,
      repository: `${serverUrl}/${repository}`,
      version,
      workflowPath,
    },
    `${serverUrl}/${workflowRef}`,
    tufCachePath,
  );
};
