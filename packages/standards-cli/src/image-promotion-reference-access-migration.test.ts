import { expect, it } from 'bun:test';
import {
  DIGEST_A,
  SHA_A,
} from './image-promotion-reference-contract-test-support';
import {
  metadataContract,
  validMetadataTransition,
} from './image-promotion-reference-metadata-test-support';
import { metadataWithoutRegistryAccess } from './image-promotion-reference-state-test-support';
import {
  disabledApp,
  metadata,
} from './image-promotion-reference-test-support';

const finalDisabled = disabledApp();
const finalLive = {
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
const legacyLive = {
  ...metadataWithoutRegistryAccess(metadata),
  digest: DIGEST_A,
  promotedSourceSha: SHA_A,
  promotionEnabled: true,
};
const finalSibling = disabledApp({
  ...metadata,
  imageRepository: 'ghcr.io/example/other',
  sourceRepository: 'example/other',
});

const migration = (
  before: unknown,
  after: unknown,
  changedFiles: ReadonlyArray<string> = [metadataContract.imagesPath],
): boolean =>
  validMetadataTransition({
    after,
    app: 'ignored-for-document-migration',
    before,
    changedFiles,
    operation: 'accessMigration',
    trustedProof: false,
  });

it('migrates one legacy entry beside unchanged final siblings', () => {
  expect(
    migration(
      { api: finalSibling, web: legacyDisabled },
      { api: finalSibling, web: finalDisabled },
    ),
  ).toBeTrue();
});

it('atomically migrates mixed live and disabled legacy entries', () => {
  expect(
    migration(
      { api: legacyLive, docs: finalSibling, web: legacyDisabled },
      { api: finalLive, docs: finalSibling, web: finalDisabled },
    ),
  ).toBeTrue();
  expect(
    migration(
      { api: legacyLive, web: legacyDisabled },
      { api: legacyLive, web: finalDisabled },
    ),
  ).toBeFalse();
});

it('compares semantically identical records without key-order dependence', () => {
  const reordered = Object.fromEntries(Object.entries(finalDisabled).reverse());
  expect(migration({ web: legacyDisabled }, { web: reordered })).toBeTrue();
});

it('rejects invalid modes and every edit beyond adding access metadata', () => {
  for (const invalidAfter of [
    { web: { ...legacyDisabled, registryAccess: 'legacy' } },
    { web: { ...finalDisabled, trackedTag: 'changed' } },
    { web: { ...finalDisabled, digest: DIGEST_A } },
    { web: { ...finalDisabled, credential: 'secret' } },
    { extra: finalSibling, web: finalDisabled },
    {},
  ]) {
    expect(migration({ web: legacyDisabled }, invalidAfter)).toBeFalse();
  }
  expect(migration({ web: finalDisabled }, { web: finalDisabled })).toBeFalse();
  expect(
    migration({ web: legacyDisabled }, { web: finalDisabled }, [
      metadataContract.imagesPath,
      'unrelated',
    ]),
  ).toBeFalse();
});
