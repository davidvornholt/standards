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
  rollback,
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
  writerContract,
} from './image-promotion-reference-test-support';

const MERGE_A = 'c'.repeat(SHA_LENGTH);
const MERGE_B = 'd'.repeat(SHA_LENGTH);
const MERGE_ROLLBACK = 'e'.repeat(SHA_LENGTH);
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
  compare: 'descendant' | 'ancestor',
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
  next = requireState(advance(next, identity, 'open'), 'advanced');
  next = requireState(advance(next, identity, 'merged', mergeSha), 'advanced');
  return requireState(deploy(next, identity, mergeSha, true), 'advanced');
};

it('uses a new audited operation for A to B to rollback A', () => {
  const a = candidate(SHA_A, DIGEST_A, '41');
  let state = requireState(
    announceCandidate(initialState(), a, 'descendant'),
    'started',
  );
  state = progress(state, canonicalIdentity(a), MERGE_A);
  const b = candidate(SHA_B, DIGEST_B, '42');
  state = requireState(announceCandidate(state, b, 'descendant'), 'started');
  state = progress(state, canonicalIdentity(b), MERGE_B);
  const target = { ...a, sourceRunId: '43' };
  expect(announceCandidate(state, target, 'ancestor').kind).toBe('stale');
  const audit = {
    exactAncestorDigestProof: true,
    nonEmptyReason: 'incident rollback',
    operator: 'release-manager',
    protectedApproval: true,
  };
  state = requireState(
    rollback({
      audit,
      compare: 'ancestor',
      proof: target,
      provenance: validEvidence(),
      state,
      target,
    }),
    'started',
  );
  const identity = Object.keys(state.operations).find((key) =>
    key.startsWith('rollback:'),
  );
  expect(identity).toBeString();
  state = progress(state, identity as string, MERGE_ROLLBACK);
  expect(state.app).toMatchObject({
    digest: DIGEST_A,
    promotedSourceSha: SHA_A,
  });
  expect(state.operations[identity as string]).toMatchObject({
    kind: 'rollback',
    phase: 'completed',
    prNumber: 3,
  });
  for (const required of writerContract.rollback.required) {
    const invalid = { ...audit, [required]: '' };
    const before = progress(
      requireState(
        announceCandidate(initialState(), a, 'descendant'),
        'started',
      ),
      canonicalIdentity(a),
      MERGE_A,
    );
    const result = rollback({
      audit: invalid,
      compare: 'ancestor',
      proof: target,
      provenance: validEvidence(),
      state: before,
      target,
    });
    expect(result.kind, required).toBe('rejected');
    expect(result.state, required).toEqual(before);
  }
});
