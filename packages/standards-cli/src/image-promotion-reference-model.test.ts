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
  type AppState,
  canonicalIdentity,
  deployable,
  disabledApp,
  metadata,
  type Promotion,
  type PromotionState,
  promote,
  reviewedMetadata,
  validProvenance,
} from './image-promotion-reference-test-support';

const THIRD_GENERATION = 3;
const candidate = (
  sourceSha: string,
  digest: string,
  generation: number,
  sourceRunId: string,
): Promotion => ({
  ...metadata,
  digest,
  generation,
  sourceRunId,
  sourceSha,
});

const proofFor = ({ generation: _generation, ...proof }: Promotion) => proof;
const initialState = (): PromotionState => ({
  app: disabledApp(),
  completions: {},
  generation: 0,
});

const acceptedState = (
  state: PromotionState,
  value: Promotion,
): PromotionState => {
  const result = promote(state, value, proofFor(value), validProvenance);
  if (result.kind !== 'accepted') {
    throw new Error('fixture promotion was not accepted');
  }
  return result.state;
};

it('executes adoption, metadata change, removal, and first promotion', () => {
  const adopted = reviewedMetadata(undefined, metadata);
  expect(adopted).toEqual(disabledApp());
  expect(deployable(adopted as AppState)).toBeFalse();

  const first = candidate(SHA_A, DIGEST_A, 1, '41');
  const live = acceptedState(
    { ...initialState(), app: adopted as AppState },
    first,
  ).app;
  expect(deployable(live)).toBeTrue();
  expect(reviewedMetadata(live, undefined)).toBe('reject');

  const changedMetadata = {
    ...metadata,
    trackedTag: 'production',
  };
  const changed = reviewedMetadata(live, changedMetadata);
  expect(changed).toEqual(disabledApp(changedMetadata));
  expect(deployable(changed as AppState)).toBeFalse();
  expect(reviewedMetadata(changed as AppState, undefined)).toBeUndefined();
  expect(deployable(undefined)).toBeFalse();

  const repromoted = acceptedState(
    { app: changed as AppState, completions: {}, generation: 0 },
    { ...candidate(SHA_B, DIGEST_B, 1, '42'), ...changedMetadata },
  );
  expect(repromoted.app).toMatchObject({
    digest: DIGEST_B,
    promotedSourceSha: SHA_B,
    promotionEnabled: true,
    trackedTag: 'production',
  });
});

it('resolves original and distinct valid run ids to one canonical promotion', () => {
  const original = candidate(SHA_B, DIGEST_B, 2, '42');
  const first = acceptedState(initialState(), original);
  const redelivery = promote(
    first,
    original,
    proofFor(original),
    validProvenance,
  );
  expect(redelivery.kind).toBe('duplicate');

  const secondRun = { ...original, sourceRunId: '43' };
  const duplicate = promote(
    redelivery.state,
    secondRun,
    proofFor(secondRun),
    validProvenance,
  );
  expect(duplicate.kind).toBe('duplicate');
  const identity = canonicalIdentity(original);
  expect(Object.keys(duplicate.state.completions)).toEqual([identity]);
  expect(duplicate.state.completions[identity]).toMatchObject({
    identity,
    number: 1,
    runEvidence: ['42', '43'],
  });
});

const runOrder = (
  values: ReadonlyArray<Promotion>,
): {
  readonly kinds: ReadonlyArray<string>;
  readonly state: PromotionState;
} => {
  let state = acceptedState(
    initialState(),
    candidate(SHA_A, DIGEST_A, 1, '40'),
  );
  const kinds: Array<string> = [];
  for (const value of values) {
    const result = promote(state, value, proofFor(value), validProvenance);
    kinds.push(result.kind);
    ({ state } = result);
  }
  return { kinds, state };
};

it('permutes reverse, duplicate, and stale announcements', () => {
  const b = candidate(SHA_B, DIGEST_B, 2, '42');
  const c = candidate(SHA_C, DIGEST_C, THIRD_GENERATION, '43');
  const forward = runOrder([b, c]);
  const reverse = runOrder([c, b]);
  const duplicate = runOrder([b, b]);

  expect(forward.kinds).toEqual(['accepted', 'accepted']);
  expect(reverse.kinds).toEqual(['accepted', 'stale']);
  expect(duplicate.kinds).toEqual(['accepted', 'duplicate']);
  for (const result of [forward, reverse]) {
    expect(result.state.app).toMatchObject({
      digest: DIGEST_C,
      promotedSourceSha: SHA_C,
    });
  }
  expect(duplicate.state.app.digest).toBe(DIGEST_B);
});

it('rejects every tampered provenance field, proof, and same-SHA digest', () => {
  const value = candidate(SHA_B, DIGEST_B, 2, '42');
  for (const key of Object.keys(validProvenance)) {
    const provenance = { ...validProvenance, [key]: false };
    expect(
      promote(initialState(), value, proofFor(value), provenance).kind,
    ).toBe('rejected');
  }
  expect(
    promote(
      initialState(),
      value,
      { ...proofFor(value), digest: DIGEST_C },
      validProvenance,
    ).kind,
  ).toBe('rejected');
  const live = acceptedState(initialState(), value);
  const conflict = { ...value, digest: DIGEST_C, sourceRunId: '44' };
  expect(
    promote(live, conflict, proofFor(conflict), validProvenance).kind,
  ).toBe('rejected');
});
