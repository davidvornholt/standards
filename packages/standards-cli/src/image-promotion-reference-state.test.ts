import { expect, it } from 'bun:test';
import {
  DIGEST_A,
  SHA_A,
} from './image-promotion-reference-contract-test-support';
import {
  metadataContract,
  validMetadataTransition,
} from './image-promotion-reference-metadata-test-support';
import {
  isValidAppState,
  metadataWithoutRegistryAccess,
} from './image-promotion-reference-state-test-support';
import {
  disabledApp,
  metadata,
} from './image-promotion-reference-test-support';

const disabled = disabledApp();
const live = {
  ...metadata,
  digest: DIGEST_A,
  promotedSourceSha: SHA_A,
  promotionEnabled: true,
};
const legacyDisabled = {
  ...metadataWithoutRegistryAccess(metadata),
  digest: null,
  promotedSourceSha: null,
  promotionEnabled: false,
};

const transition = (
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  operation:
    | 'accessMigration'
    | 'bootstrap'
    | 'disable'
    | 'metadata'
    | 'remove'
    | 'trustedPromotion',
  trustedProof = false,
): boolean =>
  validMetadataTransition({
    after,
    app: 'web',
    before,
    changedFiles: [metadataContract.imagesPath],
    operation,
    trustedProof,
  });

it('validates the exact final desired-state shape at runtime', () => {
  expect(isValidAppState(disabled)).toBeTrue();
  expect(isValidAppState(live)).toBeTrue();
  const { registryAccess: _registryAccess, ...missingAccess } = disabled;
  for (const invalid of [
    missingAccess,
    { ...disabled, registryAccess: 'legacy' },
    { ...disabled, credential: 'secret' },
    { ...disabled, unexpected: true },
    { ...disabled, imageRepository: 'docker.io/example/app' },
    {
      ...disabled,
      imageRepository: { toString: () => metadata.imageRepository },
    },
    {
      ...disabled,
      sourceWorkflow: { ...metadata.sourceWorkflow, extra: true },
    },
    { ...disabled, digest: DIGEST_A },
  ]) {
    expect(isValidAppState(invalid)).toBeFalse();
  }
});

it('rejects legacy and invalid shapes in every normal transition class', () => {
  const invalidStates = [
    legacyDisabled,
    { ...disabled, registryAccess: 'legacy' },
    { ...disabled, unexpected: true },
    { ...disabled, credential: 'secret' },
  ];
  for (const invalid of invalidStates) {
    expect(transition({}, { web: invalid }, 'bootstrap')).toBeFalse();
    expect(
      transition({ web: invalid }, { web: disabled }, 'disable'),
    ).toBeFalse();
    expect(
      transition({ web: invalid }, { web: disabled }, 'metadata'),
    ).toBeFalse();
    expect(transition({ web: invalid }, {}, 'remove')).toBeFalse();
    expect(
      transition({ web: disabled }, { web: invalid }, 'trustedPromotion', true),
    ).toBeFalse();
  }
});
