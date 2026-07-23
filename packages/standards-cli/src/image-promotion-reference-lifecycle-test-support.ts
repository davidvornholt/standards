import {
  type Compare,
  canonicalIdentity,
  type ModelResult,
  type Operation,
  type Promotion,
  type PromotionState,
  writerContract,
} from './image-promotion-reference-test-support';

const evidencePasses = (
  evidence: Readonly<Record<string, boolean>>,
  required: ReadonlyArray<string>,
): boolean => required.every((name) => evidence[name] === true);

export const advance = (
  state: PromotionState,
  identity: string,
  phase: Operation['phase'],
  mergeSha: string | null = null,
): ModelResult => {
  const operation = state.operations[identity];
  if (operation === undefined) {
    return { kind: 'rejected', state };
  }
  const currentIndex = writerContract.lifecycle.indexOf(operation.phase);
  const nextIndex = writerContract.lifecycle.indexOf(phase);
  const valid =
    nextIndex === currentIndex + 1 ||
    (operation.phase === 'merged' && phase === 'completed') ||
    (operation.phase === 'deploy-failed' && phase === 'completed');
  if (
    !valid ||
    (phase === 'merged' && mergeSha === null) ||
    (phase !== 'merged' && mergeSha !== null)
  ) {
    return { kind: 'rejected', state };
  }
  const updated: Operation = {
    ...operation,
    mergeSha: phase === 'merged' ? mergeSha : operation.mergeSha,
    phase,
    prNumber: phase === 'open' ? state.nextPrNumber : operation.prNumber,
  };
  return {
    kind: 'advanced',
    state: {
      app:
        phase === 'merged'
          ? {
              ...state.app,
              digest: operation.candidate.digest,
              promotedSourceSha: operation.candidate.sourceSha,
              promotionEnabled: true,
            }
          : state.app,
      nextPrNumber:
        phase === 'open' ? state.nextPrNumber + 1 : state.nextPrNumber,
      operations: { ...state.operations, [identity]: updated },
    },
  };
};

export const deploy = (
  state: PromotionState,
  identity: string,
  mergeSha: string,
  success: boolean,
): ModelResult => {
  const operation = state.operations[identity];
  if (
    operation === undefined ||
    operation.mergeSha !== mergeSha ||
    !['merged', 'deploy-failed'].includes(operation.phase)
  ) {
    return { kind: 'rejected', state };
  }
  return advance(state, identity, success ? 'completed' : 'deploy-failed');
};

export const rollback = ({
  audit,
  compare,
  proof,
  provenance,
  state,
  target,
}: {
  readonly audit: Readonly<Record<string, string | boolean>>;
  readonly compare: Compare;
  readonly proof: Promotion;
  readonly provenance: Readonly<Record<string, boolean>>;
  readonly state: PromotionState;
  readonly target: Promotion;
}): ModelResult => {
  const current = `${state.app.sourceRepository}@${state.app.promotedSourceSha} digest=${state.app.digest}`;
  const identity = `rollback:${current}->${canonicalIdentity(target)}`;
  const auditEvidence = Object.fromEntries(
    Object.entries(audit).map(([key, value]) => [key, Boolean(value)]),
  );
  if (
    compare !== 'ancestor' ||
    JSON.stringify(target) !== JSON.stringify(proof) ||
    !evidencePasses(provenance, writerContract.requiredProvenance) ||
    !evidencePasses(auditEvidence, writerContract.rollback.required) ||
    state.operations[identity] !== undefined
  ) {
    return { kind: 'rejected', state };
  }
  const operation: Operation = {
    candidate: target,
    identity,
    kind: 'rollback',
    mergeSha: null,
    phase: 'announced',
    prNumber: null,
    runEvidence: [target.sourceRunId],
  };
  return {
    kind: 'started',
    state: {
      ...state,
      operations: { ...state.operations, [identity]: operation },
    },
  };
};
