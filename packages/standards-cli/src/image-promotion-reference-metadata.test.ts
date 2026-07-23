import { expect, it } from 'bun:test';
import {
  DIGEST_A,
  SHA_A,
} from './image-promotion-reference-contract-test-support';
import {
  type Images,
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
  trackedTag: 'production',
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
  readonly operation:
    | 'bootstrap'
    | 'disable'
    | 'metadata'
    | 'remove'
    | 'trustedPromotion';
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
});

it('rejects unrelated app and file edits from full before/after state', () => {
  const changedOther = {
    ...other,
    trackedTag: 'attacker',
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
