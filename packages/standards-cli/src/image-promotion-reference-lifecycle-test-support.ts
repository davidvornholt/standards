import { isValidAppState } from './image-promotion-reference-state-test-support';
import {
  type Compare,
  type ModelResult,
  type Operation,
  type PromotionState,
  writerContract,
} from './image-promotion-reference-test-support';

const allowedTransitions: Readonly<
  Record<Operation['phase'], ReadonlyArray<Operation['phase']>>
> = {
  announced: ['branch'],
  branch: ['open'],
  completed: [],
  'deploy-failed': ['deploy-failed', 'completed'],
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
    (phase === 'merged' &&
      (state.app.promotionPaused === true ||
        mergeSha === null ||
        operation.readyForReview !== true)) ||
    (phase !== 'merged' && mergeSha !== null)
  ) {
    return { kind: 'rejected', state };
  }
  const updated: Operation = {
    ...operation,
    mergeSha: phase === 'merged' ? mergeSha : operation.mergeSha,
    phase,
    prNumber: phase === 'open' ? state.nextPrNumber : operation.prNumber,
    readyForReview:
      phase === 'open'
        ? !Object.values(state.operations).some(
            (other) => other.phase === 'open',
          )
        : operation.readyForReview,
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
  failedClosures: ReadonlySet<string> = new Set(),
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
    operation === undefined ||
    writerContract.superseding.trigger !== 'promotion-opened-or-reused'
  ) {
    return opened;
  }
  const candidates = Object.entries(opened.state.operations).filter(
    ([otherIdentity, other]) =>
      otherIdentity !== identity && other.phase === 'open',
  );
  const pending = candidates.some(
    ([otherIdentity]) =>
      comparisons[otherIdentity] === undefined ||
      comparisons[otherIdentity] === 'unprovable' ||
      (comparisons[otherIdentity] === 'descendant' &&
        failedClosures.has(otherIdentity)),
  );
  const retired = new Set(
    candidates
      .filter(
        ([otherIdentity]) =>
          comparisons[otherIdentity] === 'descendant' &&
          !failedClosures.has(otherIdentity),
      )
      .map(([otherIdentity]) => otherIdentity),
  );
  const operations = Object.fromEntries(
    Object.entries(opened.state.operations).map(([otherIdentity, other]) => [
      otherIdentity,
      retired.has(otherIdentity)
        ? { ...other, phase: writerContract.superseding.result }
        : other,
    ]),
  );
  return {
    kind: 'advanced',
    state: {
      ...opened.state,
      operations: {
        ...operations,
        [identity]: { ...operation, readyForReview: !pending },
      },
    },
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
