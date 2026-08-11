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
  rollback,
} from './image-promotion-reference-lifecycle-test-support';
import {
  type AppState,
  announce,
  canonicalIdentity,
  disabledApp,
  metadata,
  type Promotion,
  type PromotionState,
  validEvidence,
  writerContract,
} from './image-promotion-reference-test-support';

const MERGE_A = 'c'.repeat(SHA_LENGTH);
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
  result: ReturnType<typeof announce>,
  kind: typeof result.kind,
): PromotionState => {
  if (result.kind !== kind) {
    throw new Error(`expected ${kind}, received ${result.kind}`);
  }
  return result.state;
};
const announceCandidate = (
  state: PromotionState,
  value: Promotion,
  compare: 'same' | 'descendant' | 'ancestor' | 'diverged' | 'unprovable',
) =>
  announce({
    candidate: value,
    compare,
    evidence: validEvidence(),
    proof: value,
    state,
  });
const progress = (
  state: PromotionState,
  identity: string,
  mergeSha: string,
): PromotionState => {
  let next = requireState(advance(state, identity, 'branch'), 'advanced');
  next = requireState(openPromotion(next, identity, {}), 'advanced');
  next = requireState(advance(next, identity, 'merged', mergeSha), 'advanced');
  return requireState(deploy(next, identity, mergeSha, true), 'advanced');
};

it('parses compare outcomes and makes every provenance condition fail closed', () => {
  expect(writerContract.lifecycle).toEqual([
    'announced',
    'branch',
    'open',
    'merged',
    'deploy-failed',
    'completed',
    'superseded',
  ]);
  expect(writerContract.superseding).toEqual({
    candidates: 'same-app-open-promotions',
    compareOutcome: 'descendant',
    result: 'superseded',
    trigger: 'promotion-opened-or-reused',
  });
  const value = candidate(SHA_A, DIGEST_A, '41');
  for (const condition of writerContract.requiredProvenance) {
    const evidence = { ...validEvidence(), [condition]: false };
    const before = initialState();
    const result = announce({
      candidate: value,
      compare: 'descendant',
      evidence,
      proof: value,
      state: before,
    });
    expect(result.kind, condition).toBe('rejected');
    expect(result.state, condition).toEqual(before);
  }
  const wrongProof = { ...value, digest: DIGEST_B };
  expect(
    announce({
      candidate: value,
      compare: 'descendant',
      evidence: validEvidence(),
      proof: wrongProof,
      state: initialState(),
    }).kind,
  ).toBe('rejected');
});

it('executes same, descendant, ancestor, diverged, and unprovable outcomes', () => {
  const a = candidate(SHA_A, DIGEST_A, '41');
  let state = requireState(
    announceCandidate(initialState(), a, 'descendant'),
    'started',
  );
  state = progress(state, canonicalIdentity(a), MERGE_A);
  const same = { ...a, sourceRunId: '42' };
  expect(announceCandidate(state, same, 'same').kind).toBe('attached');
  const b = candidate(SHA_B, DIGEST_B, '43');
  expect(announceCandidate(state, b, 'descendant').kind).toBe('started');
  for (const compare of ['ancestor', 'diverged', 'unprovable'] as const) {
    const result = announceCandidate(state, b, compare);
    expect(result.kind).toBe(compare === 'ancestor' ? 'stale' : 'rejected');
    expect(result.state).toEqual(state);
  }
  const conflict = { ...a, digest: DIGEST_B, sourceRunId: '44' };
  expect(announceCandidate(state, conflict, 'same').kind).toBe('rejected');
});

it('makes every promotion operation reject an invalid desired-state object', () => {
  const value = candidate(SHA_A, DIGEST_A, '41');
  const invalidApp = {
    ...disabledApp(),
    credential: 'secret',
  } as unknown as AppState;
  const state: PromotionState = {
    ...initialState(),
    app: invalidApp,
  };
  expect(announceCandidate(state, value, 'descendant').kind).toBe('rejected');
  expect(advance(state, canonicalIdentity(value), 'branch').kind).toBe(
    'rejected',
  );
  expect(openPromotion(state, canonicalIdentity(value), {}).kind).toBe(
    'rejected',
  );
  expect(deploy(state, canonicalIdentity(value), MERGE_A, true).kind).toBe(
    'rejected',
  );
  expect(
    rollback({
      audit: Object.fromEntries(
        writerContract.rollback.required.map((name) => [name, true]),
      ),
      compare: 'ancestor',
      proof: value,
      provenance: validEvidence(),
      state,
      target: value,
    }).kind,
  ).toBe('rejected');
});
