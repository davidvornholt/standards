import { isDeepStrictEqual } from 'node:util';
import { yamlContract } from './image-promotion-reference-contract-test-support';
import {
  isLegacyAppState,
  isValidAppState,
} from './image-promotion-reference-state-test-support';
import type {
  AppState,
  Metadata,
} from './image-promotion-reference-test-support';

type MetadataContract = {
  readonly disabledPin: {
    readonly digest: null;
    readonly promotedSourceSha: null;
    readonly promotionEnabled: false;
  };
  readonly imagesPath: string;
  readonly metadataFields: ReadonlyArray<keyof Metadata>;
  readonly operations: Readonly<
    Record<
      | 'accessMigration'
      | 'bootstrap'
      | 'disable'
      | 'metadata'
      | 'remove'
      | 'trustedPromotion',
      string
    >
  >;
};
export type Images = Readonly<Record<string, unknown>>;
export type MetadataOperation = keyof MetadataContract['operations'];
export const metadataContract = yamlContract<MetadataContract>(
  'metadata-transition',
);

const equal = (left: unknown, right: unknown): boolean =>
  isDeepStrictEqual(left, right);
const metadataOf = (app: AppState): Metadata =>
  Object.fromEntries(
    metadataContract.metadataFields.map((field) => [field, app[field]]),
  ) as Metadata;
const disabled = (app: unknown): app is AppState =>
  isValidAppState(app) &&
  app.promotionEnabled === metadataContract.disabledPin.promotionEnabled &&
  app.digest === metadataContract.disabledPin.digest &&
  app.promotedSourceSha === metadataContract.disabledPin.promotedSourceSha;
const otherAppsUnchanged = (
  before: Images,
  after: Images,
  app: string,
): boolean => {
  const omit = (images: Images) =>
    Object.fromEntries(Object.entries(images).filter(([name]) => name !== app));
  return equal(omit(before), omit(after));
};

const isPlainRecord = (value: unknown): value is Images =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const allAppsValid = (images: Images): boolean =>
  Object.values(images).every(isValidAppState);

const validAccessMigration = (before: Images, after: Images): boolean => {
  const names = Object.keys(before);
  if (!equal([...names].sort(), Object.keys(after).sort())) {
    return false;
  }
  let migrated = false;
  for (const name of names) {
    const current = before[name];
    const next = after[name];
    if (isLegacyAppState(current)) {
      if (!isValidAppState(next)) {
        return false;
      }
      const { registryAccess: _registryAccess, ...finalWithoutAccess } = next;
      if (!equal(current, finalWithoutAccess)) {
        return false;
      }
      migrated = true;
    } else if (!(isValidAppState(current) && equal(current, next))) {
      return false;
    }
  }
  return migrated;
};

export const validMetadataTransition = ({
  after,
  app,
  before,
  changedFiles,
  operation,
  trustedProof,
}: {
  readonly after: unknown;
  readonly app: string;
  readonly before: unknown;
  readonly changedFiles: ReadonlyArray<string>;
  readonly operation: MetadataOperation;
  readonly trustedProof: boolean;
}): boolean => {
  if (
    !(
      equal(changedFiles, [metadataContract.imagesPath]) &&
      isPlainRecord(before) &&
      isPlainRecord(after)
    )
  ) {
    return false;
  }
  if (operation === 'accessMigration') {
    return validAccessMigration(before, after);
  }
  if (!otherAppsUnchanged(before, after, app)) {
    return false;
  }
  if (!(allAppsValid(before) && allAppsValid(after))) {
    return false;
  }
  const current = before[app];
  const next = after[app];
  if (operation === 'bootstrap') {
    return current === undefined && disabled(next);
  }
  if (operation === 'disable') {
    return (
      isValidAppState(current) &&
      current.promotionEnabled === true &&
      disabled(next) &&
      equal(metadataOf(current), metadataOf(next))
    );
  }
  if (operation === 'metadata') {
    return (
      disabled(current) &&
      disabled(next) &&
      !equal(metadataOf(current), metadataOf(next))
    );
  }
  if (operation === 'remove') {
    return disabled(current) && next === undefined;
  }
  return (
    operation === 'trustedPromotion' &&
    trustedProof &&
    disabled(current) &&
    isValidAppState(next) &&
    next.promotionEnabled === true &&
    typeof next.digest === 'string' &&
    typeof next.promotedSourceSha === 'string' &&
    equal(metadataOf(current), metadataOf(next))
  );
};
