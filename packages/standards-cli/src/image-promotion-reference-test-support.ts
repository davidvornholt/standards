import { SHA_LENGTH } from './image-promotion-reference-contract-test-support';

export type Metadata = {
  readonly imageRepository: string;
  readonly promotionLatencyMinutes: number;
  readonly sourceRef: string;
  readonly sourceRepository: string;
  readonly trackedTag: string;
};
type DisabledPin = {
  readonly digest: null;
  readonly promotedSourceSha: null;
  readonly promotionEnabled: false;
};
type LivePin = {
  readonly digest: string;
  readonly promotedSourceSha: string;
  readonly promotionEnabled: true;
};
export type AppState = Metadata & (DisabledPin | LivePin);
export type Promotion = {
  readonly digest: string;
  readonly generation: number;
  readonly imageRepository: string;
  readonly sourceRef: string;
  readonly sourceRepository: string;
  readonly sourceRunId: string;
  readonly sourceSha: string;
};
export type Proof = Omit<Promotion, 'generation'>;
export type Provenance = {
  readonly appBot: boolean;
  readonly imagesOnly: boolean;
  readonly sameRepositoryBranch: boolean;
  readonly trustedCode: boolean;
};
export type Completion = {
  readonly identity: string;
  readonly mergeSha: string;
  readonly number: number;
  readonly runEvidence: ReadonlyArray<string>;
};
export type PromotionState = {
  readonly app: AppState;
  readonly completions: Readonly<Record<string, Completion>>;
  readonly generation: number;
};
export type ModelResult =
  | {
      readonly kind: 'accepted' | 'duplicate' | 'stale';
      readonly state: PromotionState;
    }
  | { readonly kind: 'rejected'; readonly state: PromotionState };

export const metadata: Metadata = {
  imageRepository: 'ghcr.io/example/app/web',
  promotionLatencyMinutes: 30,
  sourceRef: 'refs/heads/main',
  sourceRepository: 'example/app',
  trackedTag: 'main',
};

export const disabledApp = (value: Metadata = metadata): AppState => ({
  ...value,
  digest: null,
  promotedSourceSha: null,
  promotionEnabled: false,
});

export const canonicalIdentity = (value: Promotion): string =>
  `${value.sourceRepository}@${value.sourceSha} digest=${value.digest}`;

const proofMatches = (candidate: Promotion, proof: Proof): boolean =>
  candidate.digest === proof.digest &&
  candidate.imageRepository === proof.imageRepository &&
  candidate.sourceRef === proof.sourceRef &&
  candidate.sourceRepository === proof.sourceRepository &&
  candidate.sourceRunId === proof.sourceRunId &&
  candidate.sourceSha === proof.sourceSha;

const provenanceValid = (value: Provenance): boolean =>
  Object.values(value).every(Boolean);

export const promote = (
  state: PromotionState,
  candidate: Promotion,
  proof: Proof,
  provenance: Provenance,
): ModelResult => {
  if (
    !(proofMatches(candidate, proof) && provenanceValid(provenance)) ||
    candidate.imageRepository !== state.app.imageRepository ||
    candidate.sourceRef !== state.app.sourceRef ||
    candidate.sourceRepository !== state.app.sourceRepository
  ) {
    return { kind: 'rejected', state };
  }
  const identity = canonicalIdentity(candidate);
  const existing = state.completions[identity];
  if (existing !== undefined) {
    const runEvidence = [
      ...new Set([...existing.runEvidence, candidate.sourceRunId]),
    ];
    return {
      kind: 'duplicate',
      state: {
        ...state,
        completions: {
          ...state.completions,
          [identity]: { ...existing, runEvidence },
        },
      },
    };
  }
  if (state.app.promotionEnabled && candidate.generation < state.generation) {
    return { kind: 'stale', state };
  }
  if (state.app.promotionEnabled && candidate.generation === state.generation) {
    return { kind: 'rejected', state };
  }
  const completion: Completion = {
    identity,
    mergeSha: candidate.sourceSha.replaceAll(candidate.sourceSha[0] ?? '', 'd'),
    number: Object.keys(state.completions).length + 1,
    runEvidence: [candidate.sourceRunId],
  };
  return {
    kind: 'accepted',
    state: {
      app: {
        ...state.app,
        digest: candidate.digest,
        promotedSourceSha: candidate.sourceSha,
        promotionEnabled: true,
      },
      completions: { ...state.completions, [identity]: completion },
      generation: candidate.generation,
    },
  };
};

export const reviewedMetadata = (
  current: AppState | undefined,
  next: Metadata | undefined,
): AppState | undefined | 'reject' => {
  if (next === undefined) {
    return current?.promotionEnabled === false ? undefined : 'reject';
  }
  const unchanged = Object.entries(next).every(
    ([key, value]) => current?.[key as keyof Metadata] === value,
  );
  if (current === undefined || !unchanged) {
    return disabledApp(next);
  }
  return current;
};

export const deployable = (app: AppState | undefined): boolean =>
  app?.promotionEnabled === true &&
  app.digest.startsWith('sha256:') &&
  app.promotedSourceSha.length === SHA_LENGTH;

export const validProvenance: Provenance = {
  appBot: true,
  imagesOnly: true,
  sameRepositoryBranch: true,
  trustedCode: true,
};
