import { isValidAppState } from './image-promotion-reference-state-test-support';
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

const allowedTransitions: Readonly<
  Record<Operation['phase'], ReadonlyArray<Operation['phase']>>
> = {
  announced: ['branch'],
  branch: ['open'],
  completed: [],
  'deploy-failed': ['completed'],
  merged: ['deploy-failed', 'completed'],
  open: ['merged'],
  superseded: [],
};

export const advance = (
  state: PromotionState,
  identity: string,
  phase: Operation['phase'],
  mergeSha: string | null = null,
): ModelResult => {
  if (!isValidAppState(state.app)) {
    return { kind: 'rejected', state };
  }
  const operation = state.operations[identity];
  if (operation === undefined) {
    return { kind: 'rejected', state };
  }
  const valid = allowedTransitions[operation.phase].includes(phase);
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

export const openPromotion = (
  state: PromotionState,
  identity: string,
  comparisons: Readonly<Record<string, Compare>>,
): ModelResult => {
  if (!isValidAppState(state.app)) {
    return { kind: 'rejected', state };
  }
  const existing = state.operations[identity];
  const opened =
    existing?.phase === 'open'
      ? ({ kind: 'advanced', state } as const)
      : advance(state, identity, 'open');
  const operation = opened.state.operations[identity];
  if (
    opened.kind !== 'advanced' ||
    operation?.kind !== 'promotion' ||
    writerContract.superseding.trigger !== 'promotion-opened-or-reused'
  ) {
    return opened;
  }
  const operations = Object.fromEntries(
    Object.entries(opened.state.operations).map(
      ([otherIdentity, otherOperation]) => {
        const superseded =
          otherIdentity !== identity &&
          otherOperation.kind === 'promotion' &&
          otherOperation.phase === 'open' &&
          comparisons[otherIdentity] ===
            writerContract.superseding.compareOutcome;
        return [
          otherIdentity,
          superseded
            ? {
                ...otherOperation,
                phase: writerContract.superseding.result,
              }
            : otherOperation,
        ];
      },
    ),
  );
  return {
    kind: 'advanced',
    state: { ...opened.state, operations },
  };
};

export const deploy = (
  state: PromotionState,
  identity: string,
  mergeSha: string,
  success: boolean,
): ModelResult => {
  if (!isValidAppState(state.app)) {
    return { kind: 'rejected', state };
  }
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
  if (!isValidAppState(state.app)) {
    return { kind: 'rejected', state };
  }
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
