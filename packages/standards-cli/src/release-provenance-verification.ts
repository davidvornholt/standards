import { readFileSync } from 'node:fs';
import { verifyProvenance } from './release-provenance.ts';
import { workflowPathFromRef } from './release-provenance-claims.ts';
import type { ProvenanceVerificationResult } from './release-recovery.ts';

export type ProvenanceRequest = {
  readonly path: string;
  readonly packageName: string;
  readonly version: string;
  readonly repository: string;
  readonly serverUrl: string;
  readonly workflowRef: string;
  readonly commit: string;
  readonly installedIntegrity: string;
  readonly tufCachePath: string;
};

// Reached only through the dispatcher's `provenance` command, which imports this
// module lazily so the pure release-planning commands stay runnable from a
// source-only tree that has never installed Sigstore. Argument shape is already
// validated there, so a malformed invocation never reaches Sigstore at all.
export const verifyProvenanceRequest = (
  request: ProvenanceRequest,
): Promise<ProvenanceVerificationResult> => {
  let response: unknown;
  try {
    response = JSON.parse(readFileSync(request.path, 'utf8')) as unknown;
  } catch {
    return Promise.resolve({
      kind: 'malformed-provenance',
      message: 'npm attestation response must contain valid JSON',
    });
  }
  const workflowPath = workflowPathFromRef(
    request.repository,
    request.workflowRef,
  );
  if (workflowPath === null) {
    return Promise.resolve({
      kind: 'malformed-provenance',
      message: `Invalid GitHub workflow ref: ${request.workflowRef}`,
    });
  }
  return verifyProvenance(
    response,
    {
      commit: request.commit,
      installedIntegrity: request.installedIntegrity,
      packageName: request.packageName,
      repository: `${request.serverUrl}/${request.repository}`,
      version: request.version,
      workflowPath,
    },
    `${request.serverUrl}/${request.workflowRef}`,
    request.tufCachePath,
  );
};
