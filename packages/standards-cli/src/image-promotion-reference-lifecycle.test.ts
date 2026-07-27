import { expect, it } from 'bun:test';
import {
  DIGEST_A,
  DIGEST_B,
  SHA_A,
  SHA_B,
  SHA_LENGTH,
} from './image-promotion-reference-contract-test-support';
import {
  advance,
  deploy,
  openPromotion,
} from './image-promotion-reference-lifecycle-test-support';
import {
  announce,
  canonicalIdentity,
  disabledApp,
  type ModelResult,
  metadata,
  type Promotion,
  type PromotionState,
  validEvidence,
} from './image-promotion-reference-test-support';

const MERGE_A = 'c'.repeat(SHA_LENGTH);
const MERGE_B = 'd'.repeat(SHA_LENGTH);
const candidate = (
  sourceSha: string,
  digest: string,
  sourceRunId: string,
): Promotion => ({
  digest,
  imageRepository: metadata.imageRepository,
  sourceRef: metadata.sourceRef,
  sourceRepository: metadata.sourceRepository,
  sourceRunId,
  sourceSha,
});
const initialState = (): PromotionState => ({
  app: disabledApp(),
  nextPrNumber: 1,
  operations: {},
});
const requireState = (
  result: ModelResult,
  kind: ModelResult['kind'],
): PromotionState => {
  if (result.kind !== kind) {
    throw new Error(`expected ${kind}, received ${result.kind}`);
  }
  return result.state;
};
const announceCandidate = (
  state: PromotionState,
  value: Promotion,
  compare: 'same' | 'descendant' | 'ancestor',
) =>
  announce({
    candidate: value,
    compare,
    evidence: validEvidence(),
    proof: value,
    state,
  });

it('attaches distinct run ids throughout one operation lifecycle', () => {
  const ids = ['41', '42', '43', '44', '45', '46', '47'];
  const [
    announced,
    beforeBranch,
    duringBranch,
    duringOpen,
    afterMerge,
    afterFailure,
    afterSuccess,
  ] = ids.map((runId) => candidate(SHA_A, DIGEST_A, runId)) as [
    Promotion,
    Promotion,
    Promotion,
    Promotion,
    Promotion,
    Promotion,
    Promotion,
  ];
  let state = requireState(
    announceCandidate(initialState(), announced, 'descendant'),
    'started',
  );
  const identity = canonicalIdentity(announced);
  state = requireState(
    announceCandidate(state, beforeBranch, 'descendant'),
    'attached',
  );
  state = requireState(advance(state, identity, 'branch'), 'advanced');
  state = requireState(
    announceCandidate(state, duringBranch, 'descendant'),
    'attached',
  );
  state = requireState(openPromotion(state, identity, {}), 'advanced');
  state = requireState(
    announceCandidate(state, duringOpen, 'descendant'),
    'attached',
  );
  state = requireState(advance(state, identity, 'merged', MERGE_A), 'advanced');
  state = requireState(
    announceCandidate(state, afterMerge, 'same'),
    'attached',
  );
  expect(deploy(state, identity, MERGE_B, true).kind).toBe('rejected');
  state = requireState(deploy(state, identity, MERGE_A, false), 'advanced');
  state = requireState(
    announceCandidate(state, afterFailure, 'same'),
    'attached',
  );
  state = requireState(deploy(state, identity, MERGE_A, true), 'advanced');
  state = requireState(
    announceCandidate(state, afterSuccess, 'same'),
    'attached',
  );
  expect(Object.keys(state.operations)).toEqual([identity]);
  expect(state.operations[identity]).toMatchObject({
    phase: 'completed',
    prNumber: 1,
    runEvidence: ids,
  });
});

it('supersedes only open promotions that the new candidate is provably ahead of', () => {
  const older = candidate(SHA_A, DIGEST_A, '41');
  let state = requireState(
    announceCandidate(initialState(), older, 'descendant'),
    'started',
  );
  const olderIdentity = canonicalIdentity(older);
  state = requireState(advance(state, olderIdentity, 'branch'), 'advanced');
  state = requireState(openPromotion(state, olderIdentity, {}), 'advanced');

  const newer = candidate(SHA_B, DIGEST_B, '42');
  state = requireState(
    announceCandidate(state, newer, 'descendant'),
    'started',
  );
  const newerIdentity = canonicalIdentity(newer);
  state = requireState(advance(state, newerIdentity, 'branch'), 'advanced');
  state = requireState(openPromotion(state, newerIdentity, {}), 'advanced');
  state = requireState(
    openPromotion(state, newerIdentity, {
      [olderIdentity]: 'descendant',
    }),
    'advanced',
  );

  expect(state.operations[olderIdentity]?.phase).toBe('superseded');
  expect(state.operations[newerIdentity]?.phase).toBe('open');
  expect(advance(state, olderIdentity, 'merged', MERGE_A).kind).toBe(
    'rejected',
  );
  expect(deploy(state, olderIdentity, MERGE_A, true).kind).toBe('rejected');
  state = requireState(
    announceCandidate(state, { ...older, sourceRunId: '43' }, 'ancestor'),
    'attached',
  );
  expect(state.operations[olderIdentity]).toMatchObject({
    phase: 'superseded',
    runEvidence: ['41', '43'],
  });
});

it('leaves open promotions alone unless strict ancestry is proven', () => {
  for (const compare of [
    'same',
    'ancestor',
    'diverged',
    'unprovable',
  ] as const) {
    const older = candidate(SHA_A, DIGEST_A, `old-${compare}`);
    let state = requireState(
      announceCandidate(initialState(), older, 'descendant'),
      'started',
    );
    const olderIdentity = canonicalIdentity(older);
    state = requireState(advance(state, olderIdentity, 'branch'), 'advanced');
    state = requireState(openPromotion(state, olderIdentity, {}), 'advanced');

    const newer = candidate(SHA_B, DIGEST_B, `new-${compare}`);
    state = requireState(
      announceCandidate(state, newer, 'descendant'),
      'started',
    );
    const newerIdentity = canonicalIdentity(newer);
    state = requireState(advance(state, newerIdentity, 'branch'), 'advanced');
    state = requireState(
      openPromotion(state, newerIdentity, { [olderIdentity]: compare }),
      'advanced',
    );

    expect(state.operations[olderIdentity]?.phase, compare).toBe('open');
    expect(state.operations[newerIdentity]?.phase, compare).toBe('open');
  }
});
