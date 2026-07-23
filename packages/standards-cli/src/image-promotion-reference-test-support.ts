import { yamlContract } from './image-promotion-reference-contract-test-support';

export type Metadata = {
  readonly imageRepository: string;
  readonly promotionLatencyMinutes: number;
  readonly sourceRef: string;
  readonly sourceRepository: string;
  readonly sourceWorkflow: { readonly id: number; readonly path: string };
  readonly trackedTag: string;
};
export type AppState = Metadata & {
  readonly digest: string | null;
  readonly promotedSourceSha: string | null;
  readonly promotionEnabled: boolean;
};
export type Promotion = {
  readonly digest: string;
  readonly imageRepository: string;
  readonly sourceRef: string;
  readonly sourceRepository: string;
  readonly sourceRunId: string;
  readonly sourceSha: string;
};
export type Compare =
  | 'same'
  | 'descendant'
  | 'ancestor'
  | 'diverged'
  | 'unprovable';
type WriterContract = {
  readonly lifecycle: ReadonlyArray<Operation['phase']>;
  readonly requiredProvenance: ReadonlyArray<string>;
  readonly rollback: { readonly required: ReadonlyArray<string> };
};
export type Operation = {
  readonly candidate: Promotion;
  readonly identity: string;
  readonly kind: 'promotion' | 'rollback';
  readonly mergeSha: string | null;
  readonly phase:
    | 'announced'
    | 'branch'
    | 'open'
    | 'merged'
    | 'deploy-failed'
    | 'completed';
  readonly prNumber: number | null;
  readonly runEvidence: ReadonlyArray<string>;
};
export type PromotionState = {
  readonly app: AppState;
  readonly nextPrNumber: number;
  readonly operations: Readonly<Record<string, Operation>>;
};
export type ModelResult = {
  readonly kind: 'started' | 'attached' | 'stale' | 'rejected' | 'advanced';
  readonly state: PromotionState;
};

export const writerContract = yamlContract<WriterContract>('writer-provenance');
export const metadata: Metadata = {
  imageRepository: 'ghcr.io/example/app/web',
  promotionLatencyMinutes: 30,
  sourceRef: 'refs/heads/main',
  sourceRepository: 'example/app',
  sourceWorkflow: { id: 123_456, path: '.github/workflows/build.yml' },
  trackedTag: 'main',
};
export const disabledApp = (value: Metadata = metadata): AppState => ({
  ...value,
  digest: null,
  promotedSourceSha: null,
  promotionEnabled: false,
});
export const validEvidence = (): Readonly<Record<string, boolean>> =>
  Object.fromEntries(
    writerContract.requiredProvenance.map((name) => [name, true]),
  );
export const canonicalIdentity = (value: Promotion): string =>
  `${value.sourceRepository}@${value.sourceSha} digest=${value.digest}`;
const exactProof = (candidate: Promotion, proof: Promotion): boolean =>
  JSON.stringify(candidate) === JSON.stringify(proof);
const metadataMatches = (app: AppState, value: Promotion): boolean =>
  app.imageRepository === value.imageRepository &&
  app.sourceRef === value.sourceRef &&
  app.sourceRepository === value.sourceRepository;
const evidencePasses = (
  evidence: Readonly<Record<string, boolean>>,
  required = writerContract.requiredProvenance,
): boolean => required.every((name) => evidence[name] === true);
const attach = (
  state: PromotionState,
  operation: Operation,
  sourceRunId: string,
): PromotionState => ({
  ...state,
  operations: {
    ...state.operations,
    [operation.identity]: {
      ...operation,
      runEvidence: [...new Set([...operation.runEvidence, sourceRunId])],
    },
  },
});

export const announce = ({
  candidate,
  compare,
  evidence,
  proof,
  state,
}: {
  readonly candidate: Promotion;
  readonly compare: Compare;
  readonly evidence: Readonly<Record<string, boolean>>;
  readonly proof: Promotion;
  readonly state: PromotionState;
}): ModelResult => {
  if (
    !(
      exactProof(candidate, proof) &&
      metadataMatches(state.app, candidate) &&
      evidencePasses(evidence)
    )
  ) {
    return { kind: 'rejected', state };
  }
  const identity = canonicalIdentity(candidate);
  const existing = state.operations[identity];
  const currentMatches =
    state.app.promotedSourceSha === candidate.sourceSha &&
    state.app.digest === candidate.digest;
  if (
    existing?.kind === 'promotion' &&
    (existing.phase !== 'completed' || currentMatches)
  ) {
    return {
      kind: 'attached',
      state: attach(state, existing, candidate.sourceRunId),
    };
  }
  if (compare === 'ancestor') {
    return { kind: 'stale', state };
  }
  if (
    compare === 'diverged' ||
    compare === 'unprovable' ||
    (compare === 'same' && !currentMatches)
  ) {
    return { kind: 'rejected', state };
  }
  if (compare === 'same') {
    return { kind: 'attached', state };
  }
  const operation: Operation = {
    candidate,
    identity,
    kind: 'promotion',
    mergeSha: null,
    phase: 'announced',
    prNumber: null,
    runEvidence: [candidate.sourceRunId],
  };
  return {
    kind: 'started',
    state: {
      ...state,
      operations: { ...state.operations, [identity]: operation },
    },
  };
};
