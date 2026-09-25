import { expect, it } from 'bun:test';
import {
  DIGEST_A,
  DIGEST_B,
  DIGEST_C,
  SHA_A,
  SHA_B,
  SHA_C,
} from './image-promotion-reference-contract-test-support';
import {
  advance,
  openPromotion,
} from './image-promotion-reference-lifecycle-test-support';
import {
  announce,
  canonicalIdentity,
  disabledApp,
  metadata,
  type Promotion,
  type PromotionState,
  validEvidence,
} from './image-promotion-reference-test-support';

const candidates: ReadonlyArray<Promotion> = [
  [SHA_A, DIGEST_A],
  [SHA_B, DIGEST_B],
  [SHA_C, DIGEST_C],
].map(([sourceSha, digest]) => ({
  ...metadata,
  sourceSha,
  digest,
  sourceRunId: sourceSha,
}));
const [older, middle, newest] = candidates.map(canonicalIdentity);
const fixture = (): PromotionState => {
  let state: PromotionState = {
    app: disabledApp(),
    nextPrNumber: 1,
    operations: {},
  };
  for (const candidate of candidates) {
    ({ state } = announce({
      candidate,
      compare: 'descendant',
      evidence: validEvidence(),
      proof: candidate,
      state,
    }));
    const identity = canonicalIdentity(candidate);
    ({ state } = advance(state, identity, 'branch'));
    ({ state } = openPromotion(state, identity, {}));
  }
  return state;
};

it.each(['comparison', 'first close', 'second close'])(
  'holds the successor draft after failure at %s and converges on replay',
  (boundary) => {
    const state = fixture();
    const comparisons =
      boundary === 'comparison'
        ? {}
        : { [older]: 'descendant' as const, [middle]: 'descendant' as const };
    const failed = new Set(boundary === 'first close' ? [older] : [middle]);
    const partial = openPromotion(state, newest, comparisons, failed).state;
    expect(partial.operations[newest]?.readyForReview).toBe(false);
    expect(advance(partial, newest, 'merged', SHA_C).kind).toBe('rejected');
    const replay = openPromotion(partial, newest, {
      [older]: 'descendant',
      [middle]: 'descendant',
    }).state;
    expect(replay.operations[newest]?.readyForReview).toBe(true);
    expect(replay.operations[older]?.phase).toBe('superseded');
    expect(replay.operations[middle]?.phase).toBe('superseded');
    expect(replay.nextPrNumber).toBe(state.nextPrNumber);
    expect(replay.operations[newest]?.runEvidence).toEqual(
      state.operations[newest]?.runEvidence,
    );
    expect(advance(replay, newest, 'merged', SHA_C).kind).toBe('advanced');
  },
);
