import { expect, it } from 'bun:test';
import {
  DIGEST_A,
  SHA_A,
} from './image-promotion-reference-contract-test-support';
import {
  type MetadataOperation,
  metadataContract,
  validMetadataTransition,
} from './image-promotion-reference-metadata-test-support';
import { metadataWithoutRegistryAccess } from './image-promotion-reference-state-test-support';
import {
  disabledApp,
  metadata,
} from './image-promotion-reference-test-support';

const disabled = disabledApp();
const changed = disabledApp({ ...metadata, trackedTag: 'production' });
const live = {
  ...metadata,
  digest: DIGEST_A,
  promotedSourceSha: SHA_A,
  promotionEnabled: true,
};
const legacy = {
  ...metadataWithoutRegistryAccess(metadata),
  digest: null,
  promotedSourceSha: null,
  promotionEnabled: false,
};
const INVALID_NUMBER_ROOT = 42;

type Fixture = {
  readonly after: Readonly<Record<string, unknown>>;
  readonly before: Readonly<Record<string, unknown>>;
  readonly operation: MetadataOperation;
  readonly trustedProof: boolean;
};

const fixtures: ReadonlyArray<Fixture> = [
  {
    after: { 0: disabled },
    before: {},
    operation: 'bootstrap',
    trustedProof: false,
  },
  {
    after: { 0: disabled },
    before: { 0: live },
    operation: 'disable',
    trustedProof: false,
  },
  {
    after: { 0: changed },
    before: { 0: disabled },
    operation: 'metadata',
    trustedProof: false,
  },
  {
    after: {},
    before: { 0: disabled },
    operation: 'remove',
    trustedProof: false,
  },
  {
    after: { 0: live },
    before: { 0: disabled },
    operation: 'trustedPromotion',
    trustedProof: true,
  },
  {
    after: { 0: disabled },
    before: { 0: legacy },
    operation: 'accessMigration',
    trustedProof: false,
  },
];

const transition = (
  fixture: Fixture,
  before: unknown,
  after: unknown,
): boolean =>
  validMetadataTransition({
    after,
    app: '0',
    before,
    changedFiles: [metadataContract.imagesPath],
    operation: fixture.operation,
    trustedProof: fixture.trustedProof,
  });

const arrayRoot = (value: Readonly<Record<string, unknown>>): unknown =>
  Object.values(value);
const customPrototypeRoot = (
  value: Readonly<Record<string, unknown>>,
): unknown => Object.assign(Object.create({ inherited: true }), value);
const nullPrototypeRoot = (value: Readonly<Record<string, unknown>>): unknown =>
  Object.assign(Object.create(null), value);
const dateRoot = (value: Readonly<Record<string, unknown>>): unknown =>
  Object.assign(new Date(0), value);

it('rejects array roots on both sides of every transition operation', () => {
  for (const fixture of fixtures) {
    expect(
      transition(fixture, arrayRoot(fixture.before), fixture.after),
    ).toBeFalse();
    expect(
      transition(fixture, fixture.before, arrayRoot(fixture.after)),
    ).toBeFalse();
  }
});

it('rejects prototype-bearing and non-record roots across every operation', () => {
  const invalidRoots = [customPrototypeRoot, nullPrototypeRoot, dateRoot];
  for (const fixture of fixtures) {
    for (const invalidRoot of invalidRoots) {
      expect(
        transition(fixture, invalidRoot(fixture.before), fixture.after),
      ).toBeFalse();
      expect(
        transition(fixture, fixture.before, invalidRoot(fixture.after)),
      ).toBeFalse();
    }
  }
});

it('returns false for null and primitive roots across every operation', () => {
  for (const fixture of fixtures) {
    for (const invalidRoot of [null, 'invalid', INVALID_NUMBER_ROOT, true]) {
      expect(transition(fixture, invalidRoot, fixture.after)).toBeFalse();
      expect(transition(fixture, fixture.before, invalidRoot)).toBeFalse();
    }
  }
});
