import {
  type Bundle,
  PolicyError,
  TUFError,
  ValidationError,
  VerificationError,
  verify,
} from 'sigstore';
import {
  decodeVerifiedStatement,
  isJsonRecord,
  type JsonRecord,
  jsonArrayAt,
  jsonRecordAt,
  jsonStringAt,
  type ProvenanceExpectation,
  SLSA_PROVENANCE_TYPE,
  verifiedStatementProblems,
} from './release-provenance-claims.ts';
import type { ProvenanceVerificationResult } from './release-recovery.ts';

export const GITHUB_ACTIONS_ISSUER =
  'https://token.actions.githubusercontent.com';

type VerificationOptions = {
  readonly certificateIdentityURI: string;
  readonly certificateIssuer: string;
  readonly tufCachePath: string;
  readonly tufMirrorURL?: string;
};

const provenanceBundle = (
  response: unknown,
):
  | { readonly bundle: JsonRecord; readonly result: null }
  | {
      readonly bundle: null;
      readonly result: ProvenanceVerificationResult;
    } => {
  if (!isJsonRecord(response)) {
    return {
      bundle: null,
      result: {
        kind: 'malformed-provenance',
        message: 'npm attestation response must be a JSON object',
      },
    };
  }
  const attestations = jsonArrayAt(response, 'attestations');
  if (attestations === null) {
    return {
      bundle: null,
      result: {
        kind: 'malformed-provenance',
        message: 'npm attestation response must contain an attestations array',
      },
    };
  }
  const provenance = attestations.filter(
    (value): value is JsonRecord =>
      isJsonRecord(value) &&
      jsonStringAt(value, 'predicateType') === SLSA_PROVENANCE_TYPE,
  );
  if (provenance.length !== 1) {
    return {
      bundle: null,
      result: {
        kind: 'malformed-provenance',
        message: `npm package must have exactly one SLSA provenance attestation; found ${provenance.length}`,
      },
    };
  }
  const bundle = jsonRecordAt(provenance[0], 'bundle');
  return bundle === null
    ? {
        bundle: null,
        result: {
          kind: 'malformed-provenance',
          message: 'npm SLSA attestation bundle is malformed',
        },
      }
    : { bundle, result: null };
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const verificationFailure = (
  error: unknown,
): Exclude<ProvenanceVerificationResult, { readonly kind: 'verified' }> => {
  if (error instanceof ValidationError) {
    return {
      kind: 'malformed-provenance',
      message: `npm SLSA provenance bundle is malformed: ${errorMessage(error)}`,
    };
  }
  if (error instanceof VerificationError || error instanceof PolicyError) {
    return {
      kind: 'cryptographic-verification-failure',
      message: `npm SLSA provenance cryptographic verification failed: ${errorMessage(error)}`,
    };
  }
  const operation = error instanceof TUFError ? 'TUF verification' : 'Sigstore';
  return {
    kind: 'operational-verification-failure',
    message: `npm SLSA provenance ${operation} failed: ${errorMessage(error)}`,
  };
};

export const verifyBundleForIdentity = (
  bundle: JsonRecord,
  options: VerificationOptions,
): Promise<ProvenanceVerificationResult> =>
  verify(bundle as Bundle, {
    certificateIdentityURI: options.certificateIdentityURI,
    certificateIssuer: options.certificateIssuer,
    tufCachePath: options.tufCachePath,
    tufMirrorURL: options.tufMirrorURL,
  }).then(() => ({ kind: 'verified' }), verificationFailure);

export const verifyProvenance = (
  response: unknown,
  expected: ProvenanceExpectation,
  certificateIdentityURI: string,
  tufCachePath: string,
): Promise<ProvenanceVerificationResult> => {
  const selected = provenanceBundle(response);
  if (selected.bundle === null) {
    return Promise.resolve(selected.result);
  }
  const { bundle } = selected;
  return verifyBundleForIdentity(bundle, {
    certificateIdentityURI,
    certificateIssuer: GITHUB_ACTIONS_ISSUER,
    tufCachePath,
  }).then((verificationResult) => {
    if (verificationResult.kind !== 'verified') {
      return verificationResult;
    }
    const statement = decodeVerifiedStatement(bundle);
    if (statement === null) {
      return {
        kind: 'malformed-provenance',
        message: 'Verified npm SLSA provenance payload must contain valid JSON',
      };
    }
    const problems = verifiedStatementProblems(statement, expected);
    return problems.length === 0
      ? { kind: 'verified' }
      : {
          kind: 'cryptographic-verification-failure',
          message: problems.join('; '),
        };
  });
};
