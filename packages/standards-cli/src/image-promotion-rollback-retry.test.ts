import { expect, it } from 'bun:test';
import {
  DIGEST_A,
  DIGEST_B,
  SHA_A,
  SHA_B,
} from './image-promotion-reference-contract-test-support';
import {
  advance,
  openPromotion,
  rollback,
} from './image-promotion-reference-lifecycle-test-support';
import {
  metadata,
  type Operation,
  type Promotion,
  type PromotionState,
  validEvidence,
} from './image-promotion-reference-test-support';

const target: Promotion = {
  ...metadata,
  digest: DIGEST_A,
  sourceSha: SHA_A,
  sourceRunId: 'initial',
};
const audit = {
  protectedApproval: true,
  nonEmptyReason: 'incident',
  operator: 'maintainer',
  exactAncestorDigestProof: true,
};
const initial: PromotionState = {
  app: {
    ...metadata,
    promotionEnabled: true,
    digest: DIGEST_B,
    promotedSourceSha: SHA_B,
  },
  nextPrNumber: 1,
  operations: {},
};
const request = (state: PromotionState, run = 'initial', reason = 'incident') =>
  rollback({
    audit: { ...audit, nonEmptyReason: reason },
    compare: 'ancestor',
    proof: { ...target, sourceRunId: run },
    provenance: validEvidence(),
    state,
    target: { ...target, sourceRunId: run },
  });
const started = request(initial).state;
const identity = Object.keys(started.operations)[0] ?? '';

it.each(['announced', 'branch', 'open'] as const)(
  'resumes an audited rollback interrupted at %s',
  (phase) => {
    let state = started;
    if (phase !== 'announced') {
      ({ state } = advance(state, identity, 'branch'));
    }
    if (phase === 'open') {
      ({ state } = openPromotion(state, identity, {}));
    }
    const before = state.operations[identity];
    const resumed = request(state, 'retry');
    expect(resumed.kind).toBe('attached');
    expect(resumed.state.operations[identity]).toEqual({
      ...before,
      runEvidence: ['initial', 'retry'],
    });
    expect(resumed.state.nextPrNumber).toBe(state.nextPrNumber);
    expect(request(resumed.state, 'retry').state).toEqual(resumed.state);
    expect(request(state, 'retry', 'changed approval reason').kind).toBe(
      'rejected',
    );
  },
);

it.each(['merged', 'deploy-failed', 'completed', 'superseded'] as const)(
  'does not reopen a post-merge or terminal rollback request %s',
  (phase) => {
    const operation: Operation = { ...started.operations[identity], phase };
    const state = { ...started, operations: { [identity]: operation } };
    expect(request(state).kind).toBe('rejected');
    expect(request(state).state).toEqual(state);
  },
);
