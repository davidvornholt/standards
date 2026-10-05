import { expect, it } from 'bun:test';
import {
  DIGEST_A,
  DIGEST_B,
  SHA_A,
} from './image-promotion-reference-contract-test-support';
import {
  type Images,
  type MetadataOperation,
  metadataContract,
  validMetadataTransition,
} from './image-promotion-reference-metadata-test-support';
import {
  type AppState,
  disabledApp,
  metadata,
} from './image-promotion-reference-test-support';

const other = disabledApp({
  ...metadata,
  imageRepository: 'ghcr.io/example/other/web',
  sourceRepository: 'example/other',
});
const disabled = disabledApp();
const live: AppState = {
  ...metadata,
  digest: DIGEST_A,
  promotedSourceSha: SHA_A,
  promotionEnabled: true,
};
const changedMetadata = {
  ...metadata,
  sourceRef: 'refs/heads/production',
};
const changedRegistryAccess = {
  ...metadata,
  registryAccess: 'public' as const,
};
const transition = ({
  after,
  before,
  changedFiles = [metadataContract.imagesPath],
  operation,
  trustedProof = false,
}: {
  readonly after: Images;
  readonly before: Images;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly operation: MetadataOperation;
  readonly trustedProof?: boolean;
}) =>
  validMetadataTransition({
    after,
    app: 'web',
    before,
    changedFiles,
    operation,
    trustedProof,
  });

it('executes disabled bootstrap followed by trusted first promotion', () => {
  const before = { other };
  const adopted = { other, web: disabled };
  expect(
    transition({ after: adopted, before, operation: 'bootstrap' }),
  ).toBeTrue();
  expect(
    transition({
      after: { other, web: live },
      before,
      operation: 'bootstrap',
    }),
  ).toBeFalse();
  expect(
    transition({
      after: { other, web: live },
      before: adopted,
      operation: 'trustedPromotion',
    }),
  ).toBeFalse();
  expect(
    transition({
      after: { other, web: live },
      before: adopted,
      operation: 'trustedPromotion',
      trustedProof: true,
    }),
  ).toBeTrue();
});

it('rejects retained and partially cleared pins', () => {
  const retained = { ...live, promotionEnabled: false };
  const partialDigest = { ...retained, digest: null };
  const partialSha = { ...retained, promotedSourceSha: null };
  for (const unsafe of [retained, partialDigest, partialSha]) {
    expect(
      transition({
        after: { other, web: unsafe },
        before: { other, web: live },
        operation: 'disable',
      }),
    ).toBeFalse();
  }
});

it('requires disable and clear before metadata change or removal', () => {
  const cleared = { other, web: disabled };
  expect(
    transition({
      after: { other, web: disabledApp(changedMetadata) },
      before: { other, web: live },
      operation: 'metadata',
    }),
  ).toBeFalse();
  expect(
    transition({
      after: { other },
      before: { other, web: live },
      operation: 'remove',
    }),
  ).toBeFalse();
  expect(
    transition({
      after: cleared,
      before: { other, web: live },
      operation: 'disable',
    }),
  ).toBeTrue();
  const changed = { other, web: disabledApp(changedMetadata) };
  expect(
    transition({ after: changed, before: cleared, operation: 'metadata' }),
  ).toBeTrue();
  expect(
    transition({ after: { other }, before: changed, operation: 'remove' }),
  ).toBeTrue();
  expect(
    transition({
      after: { other, web: disabledApp(changedRegistryAccess) },
      before: cleared,
      operation: 'metadata',
    }),
  ).toBeTrue();
});

it('rejects unrelated app and file edits from full before/after state', () => {
  const changedOther = {
    ...other,
    sourceRef: 'refs/heads/attacker',
  };
  expect(
    transition({
      after: { other: changedOther, web: disabled },
      before: { other, web: live },
      operation: 'disable',
    }),
  ).toBeFalse();
  expect(
    transition({
      after: { other, web: disabled },
      before: { other, web: live },
      changedFiles: ['infra/images.json', 'backdoor.sh'],
      operation: 'disable',
    }),
  ).toBeFalse();
});

it('pauses and unpauses a live app without moving its pins', () => {
  const paused: AppState = { ...live, promotionPaused: true };
  expect(
    transition({
      after: { other, web: paused },
      before: { other, web: live },
      operation: 'pause',
    }),
  ).toBeTrue();
  expect(
    transition({
      after: { other, web: live },
      before: { other, web: paused },
      operation: 'unpause',
    }),
  ).toBeTrue();
  expect(
    transition({
      after: { other, web: disabled },
      before: { other, web: paused },
      operation: 'disable',
    }),
  ).toBeTrue();
  for (const after of [
    { ...paused, digest: DIGEST_B },
    { ...paused, sourceRef: 'refs/heads/production' },
  ]) {
    expect(
      transition({
        after: { other, web: after },
        before: { other, web: live },
        operation: 'pause',
      }),
    ).toBeFalse();
  }
  expect(
    transition({
      after: { other, web: { ...disabled, promotionPaused: true } },
      before: { other, web: disabled },
      operation: 'pause',
    }),
  ).toBeFalse();
  expect(
    transition({
      after: { other, web: paused },
      before: { other, web: disabled },
      operation: 'trustedPromotion',
      trustedProof: true,
    }),
  ).toBeFalse();
});
