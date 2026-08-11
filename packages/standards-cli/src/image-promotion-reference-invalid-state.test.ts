import { expect, it } from 'bun:test';
import {
  DIGEST_A,
  SHA_A,
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
  type ModelResult,
  metadata,
  type Operation,
  type Promotion,
  type PromotionState,
  validEvidence,
  writerContract,
} from './image-promotion-reference-test-support';

const MERGE_SHA = 'c'.repeat(SHA_LENGTH);
const candidate: Promotion = {
  digest: DIGEST_A,
  imageRepository: metadata.imageRepository,
  sourceRef: metadata.sourceRef,
  sourceRepository: metadata.sourceRepository,
  sourceRunId: '41',
  sourceSha: SHA_A,
};
const identity = canonicalIdentity(candidate);
const liveApp: AppState = {
  ...metadata,
  digest: DIGEST_A,
  promotedSourceSha: SHA_A,
  promotionEnabled: true,
};

const invalidApps = (app: AppState): ReadonlyArray<AppState> => {
  const { registryAccess: _registryAccess, ...missingAccess } = app;
  return [
    missingAccess,
    { ...app, registryAccess: 'legacy' },
    { ...app, unexpected: true },
    { ...app, credential: 'secret' },
  ] as unknown as ReadonlyArray<AppState>;
};

const operation = (
  phase: Operation['phase'],
  mergeSha: string | null = null,
): Operation => ({
  candidate,
  identity,
  kind: 'promotion',
  mergeSha,
  phase,
  prNumber: phase === 'open' ? 1 : null,
  runEvidence: [candidate.sourceRunId],
});

const stateWith = (
  app: AppState,
  phase?: Operation['phase'],
  mergeSha: string | null = null,
): PromotionState => ({
  app,
  nextPrNumber: 2,
  operations:
    phase === undefined ? {} : { [identity]: operation(phase, mergeSha) },
});

const operationResults = (
  validState: PromotionState,
  invoke: (state: PromotionState) => ModelResult,
): ReadonlyArray<ModelResult['kind']> => [
  invoke(validState).kind,
  ...invalidApps(validState.app).map(
    (invalidApp) => invoke({ ...validState, app: invalidApp }).kind,
  ),
];

const expectedResults = (
  validKind: ModelResult['kind'],
): ReadonlyArray<ModelResult['kind']> => [
  validKind,
  'rejected',
  'rejected',
  'rejected',
  'rejected',
];

it('guards announce and advance with otherwise valid operation fixtures', () => {
  expect(
    operationResults(stateWith(disabledApp()), (state) =>
      announce({
        candidate,
        compare: 'descendant',
        evidence: validEvidence(),
        proof: candidate,
        state,
      }),
    ),
  ).toEqual(expectedResults('started'));
  expect(
    operationResults(stateWith(disabledApp(), 'announced'), (state) =>
      advance(state, identity, 'branch'),
    ),
  ).toEqual(expectedResults('advanced'));
});

it('guards open and deploy with otherwise valid operation fixtures', () => {
  expect(
    operationResults(stateWith(disabledApp(), 'branch'), (state) =>
      openPromotion(state, identity, {}),
    ),
  ).toEqual(expectedResults('advanced'));
  expect(
    operationResults(stateWith(liveApp, 'merged', MERGE_SHA), (state) =>
      deploy(state, identity, MERGE_SHA, true),
    ),
  ).toEqual(expectedResults('advanced'));
});

it('guards rollback with an otherwise valid live desired state', () => {
  expect(
    operationResults(stateWith(liveApp), (state) =>
      rollback({
        audit: Object.fromEntries(
          writerContract.rollback.required.map((name) => [name, true]),
        ),
        compare: 'ancestor',
        proof: candidate,
        provenance: validEvidence(),
        state,
        target: candidate,
      }),
    ),
  ).toEqual(expectedResults('started'));
});
