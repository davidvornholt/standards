import { type Bundle, verify } from 'sigstore';
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

export const GITHUB_ACTIONS_ISSUER =
  'https://token.actions.githubusercontent.com';

type VerificationOptions = {
  readonly certificateIssuer: string;
  readonly tufCachePath: string;
};

const provenanceBundle = (
  response: unknown,
): {
  readonly bundle: JsonRecord | null;
  readonly problems: ReadonlyArray<string>;
} => {
  if (!isJsonRecord(response)) {
    return {
      bundle: null,
      problems: ['npm attestation response must be a JSON object'],
    };
  }
  const attestations = jsonArrayAt(response, 'attestations');
  if (attestations === null) {
    return {
      bundle: null,
      problems: ['npm attestation response must contain an attestations array'],
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
      problems: [
        `npm package must have exactly one SLSA provenance attestation; found ${provenance.length}`,
      ],
    };
  }
  const bundle = jsonRecordAt(provenance[0], 'bundle');
  return bundle === null
    ? { bundle: null, problems: ['npm SLSA attestation bundle is malformed'] }
    : { bundle, problems: [] };
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const verifyBundleForIssuer = (
  bundle: JsonRecord,
  options: VerificationOptions,
): Promise<string | null> =>
  verify(bundle as Bundle, {
    certificateIssuer: options.certificateIssuer,
    tufCachePath: options.tufCachePath,
  }).then(
    () => null,
    (error: unknown) => errorMessage(error),
  );

export const verifyProvenance = (
  response: unknown,
  expected: ProvenanceExpectation,
  tufCachePath: string,
): Promise<ReadonlyArray<string>> => {
  const selected = provenanceBundle(response);
  if (selected.bundle === null) {
    return Promise.resolve(selected.problems);
  }
  const { bundle } = selected;
  return verifyBundleForIssuer(bundle, {
    certificateIssuer: GITHUB_ACTIONS_ISSUER,
    tufCachePath,
  }).then((verificationProblem) => {
    if (verificationProblem !== null) {
      return [
        `npm SLSA provenance cryptographic verification failed: ${verificationProblem}`,
      ];
    }
    const statement = decodeVerifiedStatement(bundle);
    return statement === null
      ? ['Verified npm SLSA provenance payload must contain valid JSON']
      : verifiedStatementProblems(statement, expected);
  });
};
